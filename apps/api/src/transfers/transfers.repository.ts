import { type Database, type DbHandle, transfers } from '@gapless/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, type SQL, sql } from 'drizzle-orm';

import type { Cursor } from '../common/cursor.js';
import { withDatabase } from '../common/database-unavailable.js';
import { DB_HANDLE } from '../database/database.tokens.js';
import { ApiMetrics } from '../metrics/api-metrics.js';
import type { Direction, Transfer } from './transfer.js';

/** One page request. `after` is the last row of the previous page; unset for the first page. */
export type PageRequest = {
  readonly chainId: number;
  /** Lowercase, as stored. */
  readonly tokenAddress: string;
  readonly limit: number;
  readonly after?: Cursor;
};

/** Only the columns a response needs, named as the domain type. */
const TRANSFER_COLUMNS = {
  txHash: transfers.txHash,
  logIndex: transfers.logIndex,
  blockNumber: transfers.blockNumber,
  blockTimestamp: transfers.blockTimestamp,
  from: transfers.fromAddress,
  to: transfers.toAddress,
  value: transfers.value,
};

/** The keyset sort (docs/02 "Pagination"). It matches the DESC order of the three indexes. */
const NEWEST_FIRST = [desc(transfers.blockNumber), desc(transfers.logIndex)];

/**
 * Reads pages of transfers. The only place in the API that uses Drizzle for transfers (docs/05).
 *
 * Every query filters by chain and token, sorts newest first, and starts after the cursor with a
 * row comparison `(block_number, log_index) < (b, l)`. Each one is served by one of the
 * `(chain_id, …, block_number DESC, log_index DESC)` indexes, so a page costs `limit` index
 * entries however many rows the table has (docs/05 "Database"; checked with EXPLAIN in the
 * integration test).
 */
@Injectable()
export class TransfersRepository {
  private readonly db: Database;

  // Value import of ApiMetrics: Nest resolves it from the constructor type (docs/05).
  constructor(
    @Inject(DB_HANDLE) handle: DbHandle,
    private readonly metrics: ApiMetrics,
  ) {
    this.db = handle.db;
  }

  /** The newest transfers of the token. */
  listRecent(page: PageRequest): Promise<Transfer[]> {
    return withDatabase(() =>
      this.metrics.timeQuery('recent_transfers', () => this.selectPage(page)),
    );
  }

  /**
   * The transfers where `address` (lowercase) is the sender (`out`), the receiver (`in`), or either
   * (`all`).
   */
  listForAddress(page: PageRequest, address: string, direction: Direction): Promise<Transfer[]> {
    return withDatabase(() =>
      this.metrics.timeQuery('address_transfers', async () => {
        if (direction === 'out') return this.selectPage(page, eq(transfers.fromAddress, address));
        if (direction === 'in') return this.selectPage(page, eq(transfers.toAddress, address));

        // `from = a OR to = a` would make Postgres combine both indexes and then sort every match.
        // Two index scans of `limit` rows each, merged here, read at most 2 × limit entries.
        // The second side skips self-transfers (from = to = a): the first side already has them.
        const [sent, received] = await Promise.all([
          this.selectPage(page, eq(transfers.fromAddress, address)),
          this.selectPage(
            page,
            and(eq(transfers.toAddress, address), ne(transfers.fromAddress, address)),
          ),
        ]);
        return [...sent, ...received].toSorted(newestFirst).slice(0, page.limit);
      }),
    );
  }

  private selectPage(page: PageRequest, filter?: SQL): Promise<Transfer[]> {
    return this.db
      .select(TRANSFER_COLUMNS)
      .from(transfers)
      .where(
        and(
          eq(transfers.chainId, page.chainId),
          eq(transfers.tokenAddress, page.tokenAddress),
          filter,
          page.after
            ? sql`(${transfers.blockNumber}, ${transfers.logIndex}) < (${page.after.blockNumber}, ${page.after.logIndex})`
            : undefined,
        ),
      )
      .orderBy(...NEWEST_FIRST)
      .limit(page.limit);
  }
}

/** The same order as the SQL `ORDER BY`, for merging two sorted pages. */
function newestFirst(a: Transfer, b: Transfer): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
  return b.logIndex - a.logIndex;
}
