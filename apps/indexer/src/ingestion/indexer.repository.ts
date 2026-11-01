import { type Database, indexerCheckpoints, type NewTransferRow, transfers } from '@gapless/db';
import { and, between, desc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';

import { CheckpointFenceError } from './ingestion-errors.js';
import type { StoredBlock } from './reorg.js';

/** The indexer's progress for one chain and token (docs/02 `indexer_checkpoints`). */
export type Checkpoint = {
  /** The last fully processed block. */
  readonly lastBlock: bigint;
  readonly lastBlockHash: Hex;
  /** The chain head seen when the checkpoint last moved. */
  readonly headBlock: bigint;
};

export type CommitBatchInput = {
  /** The rows of the range `from`–`to`. They must all belong to this chain and token. */
  readonly rows: readonly NewTransferRow[];
  readonly from: bigint;
  readonly to: bigint;
  /** The chain's hash of `to`, the new `last_block_hash`. */
  readonly toHash: Hex;
  readonly headBlock: bigint;
};

/** The identity of one stored Transfer log: the primary key without the chain. */
export type TransferKey = {
  readonly txHash: string;
  readonly logIndex: number;
};

export type RewindInput = {
  /** The new `last_block` (from `findRewindTarget`). */
  readonly rewindTo: bigint;
  /** The chain's hash of `rewindTo`. */
  readonly rewindHash: Hex;
  /** The `last_block` the rewind starts from: the fence. */
  readonly expectedLastBlock: bigint;
};

export type RewindResult = {
  readonly checkpoint: Checkpoint;
  /** Rows deleted (every row of this token above `rewindTo`). */
  readonly deleted: number;
};

export type CommitBatchResult = {
  /** The checkpoint row as the transaction left it. */
  readonly checkpoint: Checkpoint;
  /** Rows actually inserted. Rows that already existed are not counted. */
  readonly inserted: number;
};

/**
 * Rows per INSERT. Postgres takes at most 65 535 bind parameters per statement, and a row has 10,
 * so a busy range must be split. All chunks run in the same transaction.
 */
export const INSERT_CHUNK_SIZE = 1000;

const checkpointFields = {
  lastBlock: indexerCheckpoints.lastBlock,
  lastBlockHash: indexerCheckpoints.lastBlockHash,
  headBlock: indexerCheckpoints.headBlock,
};

/**
 * The only place the indexer uses Drizzle. Every method works on one chain and token.
 *
 * It takes a `Database` instead of opening one: the indexer passes the Drizzle instance bound to
 * the advisory-lock connection, so every write runs in the leader's session (docs/03 "Leader").
 */
export class IndexerRepository {
  constructor(
    private readonly db: Database,
    private readonly chainId: number,
    private readonly tokenAddress: Address,
  ) {}

  private transfersOfThisToken() {
    return and(eq(transfers.chainId, this.chainId), eq(transfers.tokenAddress, this.tokenAddress));
  }

  private matchesThisToken() {
    return and(
      eq(indexerCheckpoints.chainId, this.chainId),
      eq(indexerCheckpoints.tokenAddress, this.tokenAddress),
    );
  }

  /**
   * Creates the first checkpoint if there is none (docs/03 "Startup"). An existing row is never
   * changed, so a restart keeps its progress.
   */
  async seedCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.db
      .insert(indexerCheckpoints)
      .values({
        chainId: this.chainId,
        tokenAddress: this.tokenAddress,
        ...checkpoint,
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing();
  }

  /** The stored checkpoint, or `null` before the first seed. */
  async readCheckpoint(): Promise<Checkpoint | null> {
    const [row] = await this.db
      .select(checkpointFields)
      .from(indexerCheckpoints)
      .where(this.matchesThisToken());
    return row === undefined ? null : toCheckpoint(row);
  }

  /** The keys of the stored transfers in `from`–`to` (inclusive), for the parity check. */
  async transferKeys(from: bigint, to: bigint): Promise<TransferKey[]> {
    return this.db
      .select({ txHash: transfers.txHash, logIndex: transfers.logIndex })
      .from(transfers)
      .where(and(this.transfersOfThisToken(), between(transfers.blockNumber, from, to)));
  }

  /** The newest stored transfer block `<= block`, for the reorg walk (docs/03 "Reorg guard"). */
  async newestTransferBlockAtOrBelow(block: bigint): Promise<StoredBlock | null> {
    const [row] = await this.db
      .select({ blockNumber: transfers.blockNumber, blockHash: transfers.blockHash })
      .from(transfers)
      .where(and(this.transfersOfThisToken(), lte(transfers.blockNumber, block)))
      .orderBy(desc(transfers.blockNumber))
      .limit(1);
    // The DB check constraint guarantees the lowercase 32-byte hash format.
    return row === undefined
      ? null
      : { blockNumber: row.blockNumber, blockHash: row.blockHash as Hex };
  }

  /**
   * Deletes every row of this token above `rewindTo` and moves the checkpoint back to it, in one
   * transaction (docs/03 "Reorg guard", step 4). The update is fenced on `expectedLastBlock`: if
   * another writer moved the checkpoint, it throws `CheckpointFenceError` and nothing is deleted.
   */
  async rewind({ rewindTo, rewindHash, expectedLastBlock }: RewindInput): Promise<RewindResult> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(transfers)
        .where(and(this.transfersOfThisToken(), gt(transfers.blockNumber, rewindTo)))
        .returning({ logIndex: transfers.logIndex });

      const [row] = await tx
        .update(indexerCheckpoints)
        .set({ lastBlock: rewindTo, lastBlockHash: rewindHash, updatedAt: sql`now()` })
        .where(and(this.matchesThisToken(), eq(indexerCheckpoints.lastBlock, expectedLastBlock)))
        .returning(checkpointFields);
      if (row === undefined) throw new CheckpointFenceError(expectedLastBlock);

      return { checkpoint: toCheckpoint(row), deleted: deleted.length };
    });
  }

  /**
   * Inserts the rows of one range and moves the checkpoint to `to`, in one transaction
   * (docs/03 "Atomic progress"). Inserts are idempotent (`ON CONFLICT DO NOTHING`).
   *
   * The update only matches while `last_block = from - 1` (docs/03 "Checkpoint fence"). If
   * another writer moved the checkpoint, it throws `CheckpointFenceError` and the whole
   * transaction, rows included, is rolled back.
   */
  async commitBatch({
    rows,
    from,
    to,
    toHash,
    headBlock,
  }: CommitBatchInput): Promise<CommitBatchResult> {
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
        const result = await tx
          .insert(transfers)
          .values(rows.slice(start, start + INSERT_CHUNK_SIZE))
          .onConflictDoNothing()
          .returning({ logIndex: transfers.logIndex });
        inserted += result.length;
      }

      const [row] = await tx
        .update(indexerCheckpoints)
        .set({ lastBlock: to, lastBlockHash: toHash, headBlock, updatedAt: sql`now()` })
        .where(and(this.matchesThisToken(), eq(indexerCheckpoints.lastBlock, from - 1n)))
        .returning(checkpointFields);
      if (row === undefined) throw new CheckpointFenceError(from - 1n);

      return { checkpoint: toCheckpoint(row), inserted };
    });
  }
}

function toCheckpoint(row: { lastBlock: bigint; lastBlockHash: string; headBlock: bigint }) {
  // The DB check constraint guarantees the lowercase 32-byte hash format.
  return { ...row, lastBlockHash: row.lastBlockHash as Hex } satisfies Checkpoint;
}
