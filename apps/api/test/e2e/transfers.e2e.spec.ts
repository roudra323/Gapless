import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgres, type TestPostgres } from '../integration/harness/postgres.js';
import { address, insertTransfers, type SeedTransfer } from '../integration/harness/seed.js';
import { startApi, type TestApi } from './harness/api.js';

let pg: TestPostgres;
let api: TestApi;

beforeAll(async () => {
  pg = await startPostgres();
  api = await startApi(pg.url);
});

afterAll(async () => {
  await api?.close();
  await pg?.stop();
});

const base64url = (text: string) => Buffer.from(text).toString('base64url');
const truncate = () => pg.handle.db.execute(sql`truncate transfers`);

type Key = string;
const keyOf = (row: { blockNumber: string | bigint; logIndex: number }): Key =>
  `${row.blockNumber}:${row.logIndex}`;

/** Newest first, the API's order (docs/02 "Pagination"). */
function newestFirst(rows: readonly SeedTransfer[]): Key[] {
  return rows
    .toSorted((a, b) => (a.block === b.block ? b.log - a.log : a.block > b.block ? -1 : 1))
    .map((row) => keyOf({ blockNumber: row.block, logIndex: row.log }));
}

type Page = { data: { blockNumber: string; logIndex: number }[]; nextCursor: string | null };

/**
 * Follows `nextCursor` to the last page. `betweenPages` runs after every page, before the next
 * request, so the test can write while a client is in the middle of a walk.
 */
async function walk(path: string, betweenPages: (page: number) => Promise<void>): Promise<Key[]> {
  const seen: Key[] = [];
  let cursor: string | null = null;
  for (let page = 1; ; page++) {
    const res = await request(api.server)
      .get(path)
      .query(cursor === null ? {} : { cursor });
    expect(res.status).toBe(200);
    const body = res.body as Page;
    seen.push(...body.data.map(keyOf));
    if (body.nextCursor === null) return seen;
    cursor = body.nextCursor;
    await betweenPages(page);
    if (page > 100) throw new Error('the walk did not end');
  }
}

describe('pagination while the indexer writes', () => {
  const A = address(1);
  const B = address(2);
  const C = address(3);
  // 30 blocks with 2 logs each: A→B, B→C, C→A, and a self-transfer A→A every 5th block.
  const initial: SeedTransfer[] = [];
  for (let i = 0; i < 30; i++) {
    const block = 1_000n + BigInt(i);
    const pairs = [
      [A, B],
      [B, C],
      [C, A],
    ] as const;
    const first = pairs[i % 3] ?? pairs[0];
    const second = i % 5 === 0 ? ([A, A] as const) : (pairs[(i + 1) % 3] ?? pairs[0]);
    initial.push({ block, log: 0, from: first[0], to: first[1] });
    initial.push({ block, log: 1, from: second[0], to: second[1] });
  }

  // Every row in the table. A walk must return exactly the rows that existed when it started.
  const stored: SeedTransfer[] = [...initial];
  // New blocks arrive above the start of the walk, as the indexer appends them.
  let nextBlock = 5_000n;
  const appendBlock = async () => {
    const block = nextBlock++;
    const rows = [
      { block, log: 0, from: A, to: B },
      { block, log: 1, from: C, to: A },
      { block, log: 2, from: A, to: A },
    ];
    await insertTransfers(pg.handle.db, rows);
    stored.push(...rows);
  };

  beforeAll(async () => {
    await truncate();
    await insertTransfers(pg.handle.db, initial);
  });

  it('GET /v1/transfers returns every row that existed at the start once, in order', async () => {
    const atStart = [...stored];
    const seen = await walk('/v1/transfers?limit=7', appendBlock);
    expect(seen).toEqual(newestFirst(atStart));
    expect(nextBlock).toBeGreaterThan(5_001n); // rows really were added mid-walk
  });

  it.each(['out', 'in', 'all'] as const)(
    'GET /v1/addresses/:address/transfers?direction=%s has no repeats or skips',
    async (direction) => {
      // A self-transfer (A→A) is both in and out, and appears once in `all`.
      const matches = (row: SeedTransfer) =>
        direction === 'out'
          ? row.from === A
          : direction === 'in'
            ? row.to === A
            : row.from === A || row.to === A;
      const before = nextBlock;
      const atStart = [...stored];
      // Mixed case on purpose: the path accepts any valid address form.
      const path = `/v1/addresses/${A.toUpperCase().replace('0X', '0x')}/transfers?direction=${direction}&limit=3`;
      const seen = await walk(path, appendBlock);
      expect(seen).toEqual(newestFirst(atStart.filter(matches)));
      expect(seen.length).toBeGreaterThan(3);
      expect(nextBlock).toBeGreaterThan(before);
    },
  );
});

describe('response format', () => {
  // Above Number.MAX_SAFE_INTEGER, so a JSON number would lose the last digit.
  const BIG_BLOCK = 9_007_199_254_740_993n;
  const MAX_UINT256 = 2n ** 256n - 1n;
  const FROM = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
  const TO = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

  beforeAll(async () => {
    await truncate();
    await insertTransfers(pg.handle.db, [
      { block: BIG_BLOCK, log: 7, from: FROM, to: TO, value: MAX_UINT256 },
    ]);
  });

  it('returns decimal strings, checksummed addresses and an ISO UTC timestamp', async () => {
    const res = await request(api.server).get('/v1/transfers');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body).toEqual({
      data: [
        {
          txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown,
          logIndex: 7,
          blockNumber: '9007199254740993',
          blockTimestamp: '2026-01-09T13:49:53.000Z',
          from: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
          to: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          value: MAX_UINT256.toString(),
        },
      ],
      nextCursor: null,
    });
    // The raw text, not only the parsed body: the numbers are JSON strings.
    expect(res.text).toContain('"blockNumber":"9007199254740993"');
  });

  it('returns an empty page for an address with no transfers', async () => {
    const res = await request(api.server).get(`/v1/addresses/${address(99)}/transfers`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], nextCursor: null });
  });
});

describe('errors', () => {
  it.each([
    ['/v1/transfers?limit=0', 400, 'INVALID_REQUEST'],
    ['/v1/transfers?limit=101', 400, 'INVALID_REQUEST'],
    ['/v1/transfers?limit=ten', 400, 'INVALID_REQUEST'],
    ['/v1/transfers?cursor=not-a-cursor!', 400, 'INVALID_CURSOR'],
    // Valid JSON for a valid position, but not the text the API issues (keys reordered).
    [`/v1/transfers?cursor=${base64url('{"l":0,"b":"1"}')}`, 400, 'INVALID_CURSOR'],
    // Above the Postgres bigint range.
    [
      `/v1/transfers?cursor=${base64url('{"b":"9223372036854775808","l":0}')}`,
      400,
      'INVALID_CURSOR',
    ],
    ['/v1/addresses/0x1234/transfers', 400, 'INVALID_ADDRESS'],
    [`/v1/addresses/${address(1)}/transfers?direction=sideways`, 400, 'INVALID_REQUEST'],
    [`/v1/addresses/${address(1)}/transfers?cursor=%20`, 400, 'INVALID_CURSOR'],
    ['/v1/nope', 404, 'NOT_FOUND'],
    ['/healthz', 404, 'NOT_FOUND'],
  ])('GET %s → %i %s as problem+json', async (path, status, errorCode) => {
    const res = await request(api.server).get(path);
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: expect.any(String) as unknown,
      status,
      detail: expect.any(String) as unknown,
      errorCode,
    });
    expect(res.text).not.toMatch(/at .+\.(ts|js):\d+/); // no stack frames
  });

  it('logs 4xx at no error level', () => {
    expect(api.logs.filter((line) => line.msg === 'request failed')).toEqual([]);
  });
});
