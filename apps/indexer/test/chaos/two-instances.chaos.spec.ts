import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seededRandom } from '../integration/harness/token.js';
import { waitFor } from '../integration/harness/wait-for.js';
import {
  captureLogs,
  type InProcessIndexer,
  startInProcess,
  startWorld,
  type World,
} from '../integration/harness/world.js';

let world: World;
const random = seededRandom(59);
const { lines, stream } = captureLogs();
const count = (msg: string) => lines.filter((line) => line.msg === msg).length;
const running: InProcessIndexer[] = [];

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await Promise.all(running.map((indexer) => indexer.stop().catch(() => undefined)));
  await world?.stop();
});

async function status(indexer: InProcessIndexer, path: '/healthz' | '/readyz'): Promise<number> {
  return (await fetch(`${indexer.healthUrl}${path}`)).status;
}

async function waitReady(indexer: InProcessIndexer, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => (await status(indexer, '/readyz')) === 200, {
    timeoutMs,
    description: 'the instance is ready (leader)',
  });
}

/** Sessions that hold an advisory lock right now. */
async function lockHolders(): Promise<number> {
  const result = await world.pg.handle.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`,
  );
  return result.rows[0]?.n ?? 0;
}

async function indexMore(transfers: number): Promise<void> {
  const last = await world.token.sendTransfers(transfers, { perBlockMax: 4, random });
  await world.token.mine(2);
  await world.waitForCheckpoint(last);
}

describe('two-instances', () => {
  it('only one instance leads and writes; the other takes over when the leader goes away', async () => {
    const a = await startInProcess(world.config(), stream);
    running.push(a);
    await waitReady(a);
    const b = await startInProcess(world.config(), stream);
    running.push(b);
    await waitFor(() => count('another instance is the leader, waiting') >= 1, {
      timeoutMs: 10_000,
      description: 'the second instance waits',
    });

    // One leader: ready. One standby: live but not ready.
    expect(await status(a, '/readyz')).toBe(200);
    expect(await status(b, '/readyz')).toBe(503);
    expect(await status(b, '/healthz')).toBe(200);
    expect(await lockHolders()).toBe(1);
    expect(count('leadership acquired')).toBe(1);

    await indexMore(40);
    expect(await world.parity()).toMatchObject({ ok: true, duplicates: [] });

    // The leader stops (a rolling deploy, a deleted pod): the standby takes over.
    await a.stop();
    running.splice(running.indexOf(a), 1);
    await waitReady(b);
    expect(count('leadership acquired')).toBe(2);
    await indexMore(30);
    expect(await world.parity()).toMatchObject({ ok: true, duplicates: [] });
  });

  it('a leader whose lock connection is killed gives up, and leads again only with the lock', async () => {
    const [b] = running;
    if (b === undefined) throw new Error('expected the remaining instance');
    const lostBefore = count('leadership lost, waiting to acquire it again');

    // Kill the session that holds the lock, as a network split or a DB failover does.
    await world.pg.handle.db.execute(sql`
      select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted`);
    await waitFor(() => count('leadership lost, waiting to acquire it again') > lostBefore, {
      timeoutMs: 10_000,
      description: 'the leader sees the lost lock',
    });

    // It is the only instance, so it takes the lock again on a new connection and goes on.
    await waitReady(b);
    expect(await lockHolders()).toBe(1);
    await indexMore(30);

    expect(await world.parity()).toMatchObject({
      ok: true,
      chainCount: 1 + 40 + 30 + 30,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
    expect(lines.some((line) => line.level === 'fatal')).toBe(false);
  });
});
