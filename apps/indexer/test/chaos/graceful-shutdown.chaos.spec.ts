import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startIndexerProcess } from '../integration/harness/indexer-process.js';
import { holdCheckpointRow, waitForBlockedWriter } from '../integration/harness/row-hold.js';
import { seededRandom } from '../integration/harness/token.js';
import { startWorld, type World } from '../integration/harness/world.js';

let world: World;
const random = seededRandom(11);
let last: bigint;

beforeAll(async () => {
  world = await startWorld();
  last = await world.token.sendTransfers(80, { perBlockMax: 4, random });
  await world.token.mine(2);
});

afterAll(async () => {
  await world?.stop();
});

describe('graceful-shutdown', () => {
  it('on SIGTERM during a batch, lets the open transaction commit and exits 0', async () => {
    await world.seedCheckpoint();
    const hold = await holdCheckpointRow(world.pg.handle);
    const child = startIndexerProcess(world.config({ BATCH_SIZE: 5n }));
    await waitForBlockedWriter(world.pg.handle);
    const before = await world.repository.readCheckpoint();
    child.kill('SIGTERM');
    // The process waits for its transaction instead of exiting.
    await delay(300);
    expect(child.lines.some((line) => line.msg === 'indexer stopped')).toBe(false);
    await hold.release();

    const { code } = await child.exited;
    expect(code).toBe(0);
    expect(child.lines.some((line) => line.msg === 'indexer stopped')).toBe(true);
    // The batch that was open committed: the checkpoint moved, and the rows came with it.
    const after = await world.repository.readCheckpoint();
    expect(after?.lastBlock).toBeGreaterThan(before?.lastBlock ?? 0n);
    expect(await world.rowsAboveCheckpoint()).toBe(0);
    expect(await world.parity()).toMatchObject({ ok: true });
  });

  it('exits 1 after SHUTDOWN_TIMEOUT_MS when the transaction can not finish, and rolls it back', async () => {
    const hold = await holdCheckpointRow(world.pg.handle);
    const child = startIndexerProcess(world.config({ BATCH_SIZE: 5n, SHUTDOWN_TIMEOUT_MS: 1000 }));
    await waitForBlockedWriter(world.pg.handle);
    const before = await world.repository.readCheckpoint();
    const sent = Date.now();
    child.kill('SIGTERM');

    const { code } = await child.exited;
    const took = Date.now() - sent;
    expect(code).toBe(1);
    expect(took).toBeGreaterThanOrEqual(1000);
    expect(took).toBeLessThan(10_000);
    expect(child.lines.find((line) => line.msg === 'shutdown timed out, exiting')).toMatchObject({
      level: 'fatal',
    });
    await hold.release();

    expect(await world.repository.readCheckpoint()).toEqual(before);
    expect(await world.rowsAboveCheckpoint()).toBe(0);
  });

  it('indexes the rest after the forced exit, with exact parity', async () => {
    const child = startIndexerProcess(world.config());
    // Signal handlers exist once boot is done; a SIGINT before that is a plain kill.
    await child.waitForLine((line) => line.msg === 'leadership acquired');
    await world.waitForCheckpoint(last);
    child.kill('SIGINT');
    expect((await child.exited).code).toBe(0);
    expect(await world.parity()).toMatchObject({
      ok: true,
      chainCount: 81,
      dbCount: 81,
      duplicates: [],
    });
  });
});
