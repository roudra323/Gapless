import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startIndexerProcess } from '../integration/harness/indexer-process.js';
import { holdCheckpointRow, waitForBlockedWriter } from '../integration/harness/row-hold.js';
import { seededRandom } from '../integration/harness/token.js';
import { startWorld, type World } from '../integration/harness/world.js';

let world: World;
const random = seededRandom(7);

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world?.stop();
});

describe('kill-mid-batch', () => {
  it('a SIGKILL inside an open batch transaction leaves no rows past the checkpoint', async () => {
    const last = await world.token.sendTransfers(120, { perBlockMax: 4, random });
    await world.token.mine(2);
    const config = world.config({ BATCH_SIZE: 5n });

    // The first batch inserts its rows, then waits on the checkpoint UPDATE: kill it right there.
    await world.seedCheckpoint();
    const hold = await holdCheckpointRow(world.pg.handle);
    const first = startIndexerProcess(config);
    await waitForBlockedWriter(world.pg.handle);
    const before = await world.repository.readCheckpoint();
    first.kill('SIGKILL');
    expect((await first.exited).signal).toBe('SIGKILL');
    await hold.release();

    // Postgres rolled the killed transaction back: no row without its checkpoint.
    expect(await world.rowsAboveCheckpoint()).toBe(0);
    expect(await world.repository.readCheckpoint()).toEqual(before);

    // A restart continues from the checkpoint, and the result is exact.
    const second = startIndexerProcess(config);
    // Signal handlers exist once boot is done; a SIGTERM before that is a plain kill.
    await second.waitForLine((line) => line.msg === 'leadership acquired');
    await world.waitForCheckpoint(last);
    second.kill('SIGTERM');
    expect((await second.exited).code).toBe(0);
    expect(await world.parity()).toMatchObject({ ok: true, missing: [], duplicates: [] });
  });

  it('survives repeated SIGKILLs at random moments, with exact parity at the end', async () => {
    const last = await world.token.sendTransfers(150, { perBlockMax: 6, random });
    await world.token.mine(2);
    // One block per batch, so the backfill takes many short transactions to kill into.
    const config = world.config({ BATCH_SIZE: 1n });

    const killedAt: bigint[] = [];
    for (let kill = 0; kill < 3; kill++) {
      const child = startIndexerProcess(config);
      // Kill right after a seeded number of commits, while the next batch is in flight.
      child.killOnLine(
        (line) => line.msg === 'batch indexed',
        2 + Math.floor(random() * 5),
        'SIGKILL',
      );
      await child.exited;
      expect(await world.rowsAboveCheckpoint()).toBe(0);
      killedAt.push((await world.repository.readCheckpoint())?.lastBlock ?? 0n);
    }
    // The kills hit a running backfill, not an indexer that was already done.
    expect(killedAt[0]).toBeLessThan(last);

    const final = startIndexerProcess(config);
    await final.waitForLine((line) => line.msg === 'leadership acquired');
    await world.waitForCheckpoint(last);
    final.kill('SIGTERM');
    expect((await final.exited).code).toBe(0);
    const report = await world.parity();
    expect(report).toMatchObject({ ok: true, missing: [], unexpected: [], duplicates: [] });
    expect(report.chainCount).toBe(1 + 120 + 150);
  });
});
