import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PageRequest } from '../../src/transfers/transfers.repository.js';
import { TransfersRepository } from '../../src/transfers/transfers.repository.js';
import { startPostgres, type TestPostgres } from './harness/postgres.js';
import { address, CHAIN_ID, insertTransfers, OTHER_TOKEN, TOKEN } from './harness/seed.js';

const A = address(0xa);
const B = address(0xb);
const C = address(0xc);

let pg: TestPostgres;
let repo: TransfersRepository;

const page = (overrides: Partial<PageRequest> = {}): PageRequest => ({
  chainId: CHAIN_ID,
  tokenAddress: TOKEN,
  limit: 100,
  ...overrides,
});

/** "block:log" keys, for readable order assertions. */
const keys = (rows: readonly { blockNumber: bigint; logIndex: number }[]): string[] =>
  rows.map((row) => `${row.blockNumber}:${row.logIndex}`);

beforeAll(async () => {
  pg = await startPostgres();
  repo = new TransfersRepository(pg.handle);
});

afterAll(async () => {
  await pg?.stop();
});

const truncate = () => pg.handle.db.execute(sql`truncate transfers`);

describe('TransfersRepository.listRecent', () => {
  beforeEach(truncate);

  it('returns the newest first, by block then log index', async () => {
    await insertTransfers(pg.handle.db, [
      { block: 10n, log: 0, from: A, to: B },
      { block: 12n, log: 1, from: A, to: B },
      { block: 12n, log: 4, from: A, to: B },
      { block: 11n, log: 9, from: A, to: B },
    ]);

    expect(keys(await repo.listRecent(page()))).toEqual(['12:4', '12:1', '11:9', '10:0']);
  });

  it('starts after the cursor and stops at the limit', async () => {
    await insertTransfers(pg.handle.db, [
      { block: 10n, log: 0, from: A, to: B },
      { block: 12n, log: 1, from: A, to: B },
      { block: 12n, log: 4, from: A, to: B },
      { block: 11n, log: 9, from: A, to: B },
    ]);

    // After (12, 4): (12, 1) is next, because the row comparison looks at the log index too.
    const rows = await repo.listRecent(
      page({ limit: 2, after: { blockNumber: 12n, logIndex: 4 } }),
    );
    expect(keys(rows)).toEqual(['12:1', '11:9']);
  });

  it('only returns the configured chain and token', async () => {
    await insertTransfers(pg.handle.db, [
      { block: 1n, log: 0, from: A, to: B },
      { block: 2n, log: 0, from: A, to: B, token: OTHER_TOKEN },
      { block: 3n, log: 0, from: A, to: B, chainId: 1 },
    ]);

    expect(keys(await repo.listRecent(page()))).toEqual(['1:0']);
  });

  it('keeps block numbers above 2^53 and uint256 values exact', async () => {
    const big = 9007199254740993n;
    const max = 2n ** 256n - 1n;
    await insertTransfers(pg.handle.db, [{ block: big, log: 0, from: A, to: B, value: max }]);

    const [row] = await repo.listRecent(page());
    expect(row).toMatchObject({ blockNumber: big, value: max, from: A, to: B });
    expect(row?.blockTimestamp).toBeInstanceOf(Date);

    // A cursor above 2^53 also works in SQL (the bigint is sent exactly).
    expect(await repo.listRecent(page({ after: { blockNumber: big, logIndex: 1 } }))).toHaveLength(
      1,
    );
  });
});

describe('TransfersRepository.listForAddress', () => {
  beforeEach(async () => {
    await truncate();
    await insertTransfers(pg.handle.db, [
      { block: 1n, log: 0, from: A, to: B }, // A out
      { block: 2n, log: 0, from: B, to: A }, // A in
      { block: 3n, log: 0, from: A, to: A }, // A to itself
      { block: 4n, log: 0, from: B, to: C }, // not A
      { block: 5n, log: 0, from: C, to: A }, // A in
    ]);
  });

  it('out: A is the sender', async () => {
    expect(keys(await repo.listForAddress(page(), A, 'out'))).toEqual(['3:0', '1:0']);
  });

  it('in: A is the receiver', async () => {
    expect(keys(await repo.listForAddress(page(), A, 'in'))).toEqual(['5:0', '3:0', '2:0']);
  });

  it('all: both sides, newest first, a self-transfer once', async () => {
    expect(keys(await repo.listForAddress(page(), A, 'all'))).toEqual(['5:0', '3:0', '2:0', '1:0']);
  });

  it('all: pages through both sides with the cursor and the limit', async () => {
    const first = await repo.listForAddress(page({ limit: 2 }), A, 'all');
    expect(keys(first)).toEqual(['5:0', '3:0']);

    const last = first.at(-1);
    const second = await repo.listForAddress(
      page({ limit: 2, after: { blockNumber: last!.blockNumber, logIndex: last!.logIndex } }),
      A,
      'all',
    );
    expect(keys(second)).toEqual(['2:0', '1:0']);
  });
});

/** Runs `fn` while recording the SQL that Drizzle sends, then EXPLAINs each statement. */
async function plansOf(fn: () => Promise<unknown>): Promise<string[]> {
  const pool = pg.handle.pool;
  const original = pool.query.bind(pool);
  const sent: { text: string; values: unknown[] }[] = [];
  // Drizzle calls `pool.query({ text, ... }, params)`: the values are the second argument.
  pool.query = ((config: { text: string }, params: unknown[] = [], ...rest: unknown[]) => {
    if (typeof config === 'object' && config.text) sent.push({ text: config.text, values: params });
    return (original as (...args: unknown[]) => unknown)(config, params, ...rest);
  }) as typeof pool.query;
  try {
    await fn();
  } finally {
    pool.query = original;
  }
  const plans: string[] = [];
  for (const query of sent) {
    const result = await pg.handle.pool.query<{ 'QUERY PLAN': string }>(
      `explain ${query.text}`,
      query.values,
    );
    plans.push(result.rows.map((row) => row['QUERY PLAN']).join('\n'));
  }
  return plans;
}

describe('query plans (docs/05: every request-path query hits an index)', () => {
  // A table large enough that a full scan would cost more than an index scan, like production.
  beforeAll(async () => {
    await truncate();
    await pg.handle.db.execute(sql`
      insert into transfers (chain_id, block_number, block_hash, block_timestamp, tx_hash,
        log_index, token_address, from_address, to_address, value)
      select ${CHAIN_ID}, g / 10, '0x' || lpad(to_hex(g / 10), 64, '0'), now(),
        '0x' || lpad(to_hex(g), 64, '0'), g % 10, ${TOKEN},
        '0x' || lpad(to_hex(g % 50 + 1), 40, '0'), '0x' || lpad(to_hex((g + 7) % 50 + 1), 40, '0'), 1
      from generate_series(1, 50000) as g`);
    await pg.handle.db.execute(sql`analyze transfers`);
  });

  const AFTER = { blockNumber: 2500n, logIndex: 5 };

  it.each([
    ['recent, first page', () => repo.listRecent(page({ limit: 26 })), 'transfers_recent_idx'],
    [
      'recent, after a cursor',
      () => repo.listRecent(page({ limit: 26, after: AFTER })),
      'transfers_recent_idx',
    ],
    [
      'address out',
      () => repo.listForAddress(page({ limit: 26, after: AFTER }), address(1), 'out'),
      'transfers_from_idx',
    ],
    [
      'address in',
      () => repo.listForAddress(page({ limit: 26, after: AFTER }), address(1), 'in'),
      'transfers_to_idx',
    ],
  ])('%s uses %s and does not sort', async (_label, query, indexName) => {
    const plans = await plansOf(query);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toContain(`Index Scan using ${indexName}`);
    // A Sort node would mean Postgres reads every match and sorts it: slow on a big table.
    expect(plans[0]).not.toMatch(/\bSort\b/);
  });

  it('address all uses both address indexes and does not sort', async () => {
    const plans = await plansOf(() =>
      repo.listForAddress(page({ limit: 26, after: AFTER }), address(1), 'all'),
    );

    expect(plans).toHaveLength(2);
    expect(plans.join('\n')).toContain('Index Scan using transfers_from_idx');
    expect(plans.join('\n')).toContain('Index Scan using transfers_to_idx');
    expect(plans.join('\n')).not.toMatch(/\bSort\b/);
  });
});
