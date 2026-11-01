import { type Database, indexerCheckpoints, type NewTransferRow, transfers } from '@gapless/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';

import { CheckpointFenceError } from './ingestion-errors.js';

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
 * It takes a `Database` instead of opening one, so Phase 4 can pass a Drizzle instance bound to
 * the advisory-lock connection (docs/03 "Leader").
 */
export class IndexerRepository {
  constructor(
    private readonly db: Database,
    private readonly chainId: number,
    private readonly tokenAddress: Address,
  ) {}

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
