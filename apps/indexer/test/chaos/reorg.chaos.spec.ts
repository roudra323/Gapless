import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seededRandom } from '../integration/harness/token.js';
import { waitFor } from '../integration/harness/wait-for.js';
import {
  captureLogs,
  startInProcess,
  startWorld,
  type World,
} from '../integration/harness/world.js';

let world: World;
const random = seededRandom(47);
const { lines, stream } = captureLogs();
const reorgLines = () => lines.filter((line) => line.msg === 'reorg detected, rewinding');

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world?.stop();
});

const keyOf = (key: { txHash: string; logIndex: number }) => `${key.txHash}:${key.logIndex}`;

/**
 * Indexes transfers on a fork, reverts the fork, mines a different longer chain from the
 * snapshot, and waits until the indexer has rewound and indexed the new chain.
 */
async function reorgScenario(options: {
  readonly rewindBlocks: bigint;
  readonly oldTransfers: number;
  readonly newTransfers: number;
}) {
  const indexer = await startInProcess(
    world.config({ CONFIRMATIONS: 0n, REORG_REWIND_BLOCKS: options.rewindBlocks }),
    stream,
  );
  // Settle on the current chain first.
  const base = await world.token.mine(1);
  await world.waitForCheckpoint(base);

  const snapshot = await world.token.snapshot();
  const forkPoint = await world.token.publicClient.getBlockNumber();
  const oldTip = await world.token.sendTransfers(options.oldTransfers, { perBlockMax: 2, random });
  await world.waitForCheckpoint(oldTip);
  const oldKeys = new Set((await world.repository.transferKeys(forkPoint + 1n, oldTip)).map(keyOf));
  expect(oldKeys.size).toBe(options.oldTransfers);

  // The reorg: drop the fork and mine a different, longer one from the same parent.
  const reorgs = async () => (await indexer.metrics()).get('gapless_indexer_reorgs_total') ?? 0;
  expect(await reorgs()).toBe(0);
  await world.token.revert(snapshot);
  let newTip = await world.token.sendTransfers(options.newTransfers, { perBlockMax: 2, random });
  if (newTip <= oldTip) newTip = await world.token.mine(Number(oldTip - newTip) + 1);

  await waitFor(async () => (await reorgs()) >= 1, {
    timeoutMs: 30_000,
    description: 'gapless_indexer_reorgs_total increments',
  });
  await world.waitForCheckpoint(newTip);
  const metrics = await indexer.metrics();
  await indexer.stop();
  // A reorg found mid-batch is a failed batch; the checkpoint gauge follows the rewind and the
  // new fork.
  expect(metrics.get('gapless_indexer_batches_total{result="error"}')).toBeGreaterThan(0);
  expect(metrics.get('gapless_indexer_processed_block')).toBeGreaterThanOrEqual(Number(newTip));

  const stored = new Set((await world.repository.transferKeys(forkPoint + 1n, newTip)).map(keyOf));
  // The rewind target is only in the log line (no metric has it).
  return { oldKeys, stored, forkPoint, oldTip, reorg: reorgLines().at(-1) };
}

describe('reorg', () => {
  it('reorg: rows of the dropped fork are deleted and the new fork is indexed', async () => {
    const { oldKeys, stored, reorg } = await reorgScenario({
      rewindBlocks: 64n,
      oldTransfers: 12,
      newTransfers: 16,
    });

    for (const key of oldKeys) expect(stored.has(key)).toBe(false);
    expect(stored.size).toBe(16);
    expect(reorg).toMatchObject({ level: 'warn', chainId: 31337 });
    expect(reorg?.storedHash).not.toBe(reorg?.chainHash);
    expect(await world.parity()).toMatchObject({
      ok: true,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
  });

  it('reorg-deep: a reorg deeper than REORG_REWIND_BLOCKS rewinds to a proven block', async () => {
    // Rewind depth 2, but the fork replaces about 10 blocks, with transfers in all of them.
    const { oldKeys, stored, forkPoint, oldTip, reorg } = await reorgScenario({
      rewindBlocks: 2n,
      oldTransfers: 20,
      newTransfers: 24,
    });

    // The walk went past `last_block - 2`, down to a block at or below the fork point.
    const rewindTo = BigInt(String(reorg?.rewindTo));
    expect(rewindTo).toBeLessThanOrEqual(forkPoint);
    expect(rewindTo).toBeLessThan(oldTip - 2n);
    for (const key of oldKeys) expect(stored.has(key)).toBe(false);
    expect(stored.size).toBe(24);
    expect(await world.parity()).toMatchObject({
      ok: true,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
  });
});
