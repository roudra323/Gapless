import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDb,
  type DbHandle,
  indexerCheckpoints,
  type NewTransferRow,
  runMigrations,
  transfers,
} from '../../src/index.js';

// Same image as docker-compose.yml. Keep the two in sync.
const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const MAX_UINT256 = 2n ** 256n - 1n;
const TOKEN = `0x${'a'.repeat(40)}`;

// Postgres SQLSTATE codes.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NUMERIC_OUT_OF_RANGE = '22003';

function hash(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function transfer(overrides: Partial<NewTransferRow> = {}): NewTransferRow {
  return {
    chainId: 31337,
    blockNumber: 1n,
    blockHash: hash(1),
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    txHash: hash(100),
    logIndex: 0,
    tokenAddress: TOKEN,
    fromAddress: `0x${'1'.repeat(40)}`,
    toAddress: `0x${'2'.repeat(40)}`,
    value: 1n,
    ...overrides,
  };
}

/** Awaits a query that must fail and returns the Postgres error under Drizzle's wrapper. */
async function pgError(query: PromiseLike<unknown>): Promise<DatabaseError> {
  try {
    await query;
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof DatabaseError) return cause;
    throw err;
  }
  throw new Error('expected the query to fail');
}

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  handle = createDb({
    url: container.getConnectionUri(),
    // An idle connection error here is a test failure: surface it as an uncaught error.
    onPoolError: (err) => {
      throw err;
    },
  });
  // The container's database is empty, so this is the "fresh database" case.
  await runMigrations(handle.db);
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

describe('migrations', () => {
  it('apply cleanly to an empty database', async () => {
    const { rows } = await handle.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(['indexer_checkpoints', 'transfers']);

    const applied = await handle.pool.query('SELECT id FROM drizzle.__drizzle_migrations');
    expect(applied.rows).toHaveLength(1);
  });

  it('are idempotent: a second run applies nothing', async () => {
    await runMigrations(handle.db);

    const { rows } = await handle.pool.query('SELECT id FROM drizzle.__drizzle_migrations');
    expect(rows).toHaveLength(1);
  });
});

describe('transfers', () => {
  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE ${transfers}`);
  });

  it('round-trips a max uint256 value and a block number above 2^53 exactly', async () => {
    const blockNumber = 2n ** 63n - 1n;
    await handle.db.insert(transfers).values(transfer({ value: MAX_UINT256, blockNumber }));

    const [row] = await handle.db.select().from(transfers);
    expect(row?.value).toBe(MAX_UINT256);
    expect(row?.blockNumber).toBe(blockNumber);
  });

  it('rejects a value with more than 78 digits', async () => {
    const error = await pgError(
      handle.db.insert(transfers).values(transfer({ value: 10n ** 78n })),
    );
    expect(error.code).toBe(NUMERIC_OUT_OF_RANGE);
  });

  it('rejects a second row with the same (chain_id, tx_hash, log_index)', async () => {
    await handle.db.insert(transfers).values(transfer());

    const error = await pgError(handle.db.insert(transfers).values(transfer({ value: 2n })));
    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe('transfers_pk');
  });

  it('makes a re-insert a no-op with onConflictDoNothing', async () => {
    await handle.db.insert(transfers).values(transfer());

    const inserted = await handle.db
      .insert(transfers)
      .values(transfer())
      .onConflictDoNothing()
      .returning();
    expect(inserted).toHaveLength(0);
    expect(await handle.db.$count(transfers)).toBe(1);
  });

  it('accepts the same tx with another log index, and the same log on another chain', async () => {
    await handle.db
      .insert(transfers)
      .values([transfer(), transfer({ logIndex: 1 }), transfer({ chainId: 8453 })]);

    expect(await handle.db.$count(transfers)).toBe(3);
  });

  it.each([
    ['block_hash', { blockHash: hash(0xabc).toUpperCase().replace('0X', '0x') }],
    ['tx_hash', { txHash: hash(100).slice(0, -1) }],
    ['token_address', { tokenAddress: `0x${'A'.repeat(40)}` }],
    ['from_address', { fromAddress: `0x${'1'.repeat(39)}` }],
    ['to_address', { toAddress: '1'.repeat(42) }],
  ] satisfies [string, Partial<NewTransferRow>][])(
    'rejects a malformed %s',
    async (column, overrides) => {
      const error = await pgError(handle.db.insert(transfers).values(transfer(overrides)));
      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe(`transfers_${column}_format`);
    },
  );

  it.each([
    ['recent feed', 'transfers_recent_idx', sql`WHERE chain_id = 31337`],
    [
      'transfers from an address',
      'transfers_from_idx',
      sql`WHERE chain_id = 31337 AND from_address = ${`0x${'1'.repeat(40)}`}`,
    ],
    [
      'transfers to an address',
      'transfers_to_idx',
      sql`WHERE chain_id = 31337 AND to_address = ${`0x${'2'.repeat(40)}`}`,
    ],
  ])('serves the %s from %s with no sort step', async (_label, indexName, where) => {
    // The table is empty, so the planner's cheapest plan says nothing about the indexes.
    // With sequential scans and sorts disabled, a Sort node appears only if no index can
    // deliver ORDER BY ... DESC (as with Drizzle's default DESC NULLS LAST).
    const plan = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_sort = off`);
      const result = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN SELECT * FROM transfers ${where} ORDER BY block_number DESC, log_index DESC LIMIT 50`,
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(plan).toContain(indexName);
    expect(plan).not.toMatch(/\bSort\b/);
  });
});

describe('indexer_checkpoints', () => {
  const checkpoint = {
    chainId: 31337,
    tokenAddress: TOKEN,
    lastBlock: 10n,
    lastBlockHash: hash(10),
    headBlock: 12n,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    await handle.db.execute(sql`TRUNCATE ${indexerCheckpoints}`);
  });

  it('holds one row per (chain_id, token_address)', async () => {
    await handle.db.insert(indexerCheckpoints).values(checkpoint);

    const error = await pgError(handle.db.insert(indexerCheckpoints).values(checkpoint));
    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe('indexer_checkpoints_pk');
  });

  it.each([
    ['token_address', { tokenAddress: TOKEN.toUpperCase().replace('0X', '0x') }],
    ['last_block_hash', { lastBlockHash: 'not-a-hash' }],
  ])('rejects a malformed %s', async (column, overrides) => {
    const error = await pgError(
      handle.db.insert(indexerCheckpoints).values({ ...checkpoint, ...overrides }),
    );
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.constraint).toBe(`indexer_checkpoints_${column}_format`);
  });
});
