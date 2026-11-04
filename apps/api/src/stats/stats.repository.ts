import { type Database, type DbHandle, indexerCheckpoints, transfers } from '@gapless/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';

import { withDatabase } from '../common/database-unavailable.js';
import { DB_HANDLE } from '../database/database.tokens.js';

/** The indexer's progress for one chain and token, from `indexer_checkpoints`. */
export type Checkpoint = {
  readonly lastBlock: bigint;
  readonly headBlock: bigint;
  readonly updatedAt: Date;
};

export type StatsSnapshot = {
  readonly totalTransfers: bigint;
  /** `undefined` before the indexer's first start for this chain and token. */
  readonly checkpoint: Checkpoint | undefined;
};

/** Reads the numbers behind `/v1/stats`. */
@Injectable()
export class StatsRepository {
  private readonly db: Database;

  constructor(@Inject(DB_HANDLE) handle: DbHandle) {
    this.db = handle.db;
  }

  /**
   * The row count and the checkpoint from one snapshot. Without it, the indexer could commit a
   * batch between the two reads, and the count would not match `lastIndexedBlock`.
   * `count(*)` is an index-only scan of `transfers_token_idx`; the checkpoint is a primary key
   * lookup.
   */
  read(chainId: number, tokenAddress: string): Promise<StatsSnapshot> {
    return withDatabase(() =>
      this.db.transaction(
        async (tx) => {
          const [counted] = await tx
            .select({ total: count() })
            .from(transfers)
            .where(and(eq(transfers.chainId, chainId), eq(transfers.tokenAddress, tokenAddress)));
          const [checkpoint] = await tx
            .select({
              lastBlock: indexerCheckpoints.lastBlock,
              headBlock: indexerCheckpoints.headBlock,
              updatedAt: indexerCheckpoints.updatedAt,
            })
            .from(indexerCheckpoints)
            .where(
              and(
                eq(indexerCheckpoints.chainId, chainId),
                eq(indexerCheckpoints.tokenAddress, tokenAddress),
              ),
            );
          return { totalTransfers: BigInt(counted?.total ?? 0), checkpoint };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }
}
