import { createDb, type DbHandle, indexerCheckpoints } from '@gapless/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LeaderLock, type LeaderSession } from '../../src/leader/leader-lock.js';
import { advisoryLockKey } from '../../src/leader/lock-key.js';
import { startPostgres, type TestPostgres } from './harness/postgres.js';
import { waitFor } from './harness/wait-for.js';

const KEY = advisoryLockKey(31337, '0x5fbdb2315678afecb367f032d93f642f64180aa3');
const APP = 'gapless-leader-test';

let pg: TestPostgres;
/** Two pools, as two indexer processes would have. */
let a: DbHandle;
let b: DbHandle;
const warnings: string[] = [];
const logger = {
  warn: (_fields: Record<string, unknown>, message: string) => warnings.push(message),
};
const open: LeaderSession[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  const pool = (name: string) =>
    createDb({ url: pg.url, applicationName: `${APP}-${name}`, onPoolError: () => undefined });
  a = pool('a');
  b = pool('b');
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.release()));
  warnings.length = 0;
});

afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await pg?.stop();
});

async function acquire(handle: DbHandle): Promise<LeaderSession | null> {
  const session = await new LeaderLock(handle.pool, KEY, logger).tryAcquire();
  if (session !== null) open.push(session);
  return session;
}

/** Ends the Postgres session that holds the lock, as a network drop or a failover does. */
async function terminateHolder(): Promise<void> {
  await pg.handle.db.execute(sql`
    select pg_terminate_backend(pid) from pg_locks
    where locktype = 'advisory' and granted
      and ((classid::bigint << 32) | objid::bigint) = ${KEY.toString()}::bigint`);
}

describe('LeaderLock (Postgres)', () => {
  it('lets only one session hold the lock', async () => {
    expect(await acquire(a)).not.toBeNull();
    expect(await acquire(b)).toBeNull();
    // A second try from the same process is a new session too, so it is also refused.
    expect(await acquire(a)).toBeNull();
  });

  it('hands the lock over after a release', async () => {
    const first = await acquire(a);
    await first?.release();
    expect(await acquire(b)).not.toBeNull();
  });

  it('returns the refused connection to the pool', async () => {
    await acquire(a);
    for (let i = 0; i < 20; i++) await acquire(b);
    expect(b.pool.totalCount).toBeLessThanOrEqual(1);
  });

  it('reports a lost lock when its connection is killed, and frees the lock', async () => {
    const leader = await acquire(a);
    if (leader === null) throw new Error('expected the lock');

    await terminateHolder();
    await waitFor(() => leader.lost.aborted, { timeoutMs: 5000, description: 'lost signal' });
    expect(warnings).toContain('leader lock connection failed');
    expect(await acquire(b)).not.toBeNull();
  });

  it('never commits a write through a session that lost the lock (no zombie writer)', async () => {
    const leader = await acquire(a);
    if (leader === null) throw new Error('expected the lock');
    await terminateHolder();
    await waitFor(() => leader.lost.aborted, { timeoutMs: 5000, description: 'lost signal' });

    await expect(
      leader.db.insert(indexerCheckpoints).values({
        chainId: 1,
        tokenAddress: `0x${'1'.repeat(40)}`,
        lastBlock: 1n,
        lastBlockHash: `0x${'a'.repeat(64)}`,
        headBlock: 1n,
        updatedAt: sql`now()`,
      }),
    ).rejects.toThrow();
    expect(await pg.handle.db.$count(indexerCheckpoints)).toBe(0);
  });

  it('loses the lock when the session ends during a query', async () => {
    const leader = await acquire(a);
    if (leader === null) throw new Error('expected the lock');

    const query = leader.db.execute(sql`select pg_sleep(30)`).catch((err: unknown) => err);
    await waitFor(
      async () =>
        (
          await pg.handle.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity where query like 'select pg_sleep%'`,
          )
        ).rows[0]?.n === 1,
      { timeoutMs: 5000, description: 'the query is running' },
    );
    await terminateHolder();

    expect(await query).toBeInstanceOf(Error);
    await waitFor(() => leader.lost.aborted, { timeoutMs: 5000, description: 'lost signal' });
  });
});
