import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  blockParam,
  logsRange,
  type RequestFault,
  type RpcProxy,
  startRpcProxy,
} from '../integration/harness/rpc-proxy.js';
import { seededRandom } from '../integration/harness/token.js';
import {
  captureLogs,
  type InProcessIndexer,
  startInProcess,
  startWorld,
  type World,
} from '../integration/harness/world.js';

/** A fake API key in the RPC URL path: it must never show up in a log line. */
const SECRET_PATH = '/v2/key-hunter2';

let world: World;
let proxy: RpcProxy;
let indexer: InProcessIndexer | undefined;
const random = seededRandom(31);
const { lines, stream } = captureLogs();
const messages = (msg: string) => lines.filter((line) => line.msg === msg);

beforeAll(async () => {
  world = await startWorld();
  proxy = await startRpcProxy(world.anvil.rpcUrl, {}, SECRET_PATH);
});

afterEach(async () => {
  await indexer?.stop();
  indexer = undefined;
  proxy.setHooks({});
});

afterAll(async () => {
  await proxy?.close();
  await world?.stop();
  // Every line of every test in this file: no secret in any of them.
  expect(JSON.stringify(lines)).not.toContain('hunter2');
});

async function exactParity(): Promise<void> {
  expect(await world.parity()).toMatchObject({
    ok: true,
    missing: [],
    unexpected: [],
    duplicates: [],
  });
}

describe('rpc chaos', () => {
  it('rpc-flaky: 30% of requests fail with 429, 500 or a reset; it retries with backoff', async () => {
    const faults: RequestFault[] = [429, 500, 'reset'];
    // Batch requests (the ones with `eth_getLogs`) fail on a fixed pattern: the first two (so one
    // step fails twice in a row and backs off longer), then every third, with the fault types in
    // turn. Batches run one after another, so the pattern does not depend on timing, and every run
    // has failed batches with each fault type. Picking them at random by request number did
    // depend on timing: on a slow runner the startup checks and head polls used the whole fault
    // window, and no batch failed.
    let batchRequests = 0;
    let batchFaults = 0;
    proxy.setHooks({
      failRequest: ({ number, calls }) => {
        if (calls.some((call) => call.method === 'eth_getLogs')) {
          const i = batchRequests++;
          return i < 2 || i % 3 === 0 ? faults[batchFaults++ % faults.length] : undefined;
        }
        // Every other request (head polls, startup checks): 30% at random, in the first 200.
        return number < 200 && random() < 0.3
          ? faults[Math.floor(random() * faults.length)]
          : undefined;
      },
    });
    const last = await world.token.sendTransfers(60, { perBlockMax: 4, random });
    await world.token.mine(2);

    // Small batches, so the run makes many requests for the faults to hit.
    indexer = await startInProcess(
      world.config({ RPC_HTTP_URL: proxy.url, BATCH_SIZE: 2n }),
      stream,
    );
    await world.waitForCheckpoint(last, 90_000);
    // The process stayed live through the failures.
    expect((await fetch(`${indexer.healthUrl}/healthz`)).status).toBe(200);

    // About 30% of the first 200 requests (or of all of them, in a shorter run).
    const exposed = Math.min(proxy.stats.requests, 200);
    expect(proxy.stats.faults).toBeGreaterThan(exposed * 0.15);
    // The metrics show the faults and the retries (docs/06 "rpc-flaky").
    const metrics = await indexer.metrics();
    expect(metrics.sum('gapless_rpc_requests_total', { result: 'error' })).toBeGreaterThan(0);
    expect(metrics.sum('gapless_rpc_requests_total', { result: 'rate_limited' })).toBeGreaterThan(
      0,
    );
    expect(metrics.get('gapless_indexer_batches_total{result="error"}')).toBeGreaterThan(0);
    expect(metrics.get('gapless_indexer_batches_total{result="ok"}')).toBeGreaterThan(0);
    // The retries use backoff: some step failed more than once in a row.
    const retries = messages('indexing step failed, retrying after backoff');
    expect(Math.max(...retries.map((line) => Number(line.attempt)))).toBeGreaterThan(0);
    await exactParity();
  });

  it('range-too-large: the RPC rejects ranges over 3 blocks; the batch halves, then parity', async () => {
    const limit = 3n;
    proxy.setHooks({
      interceptCall: (call) => {
        const range = call.method === 'eth_getLogs' ? logsRange(call) : undefined;
        if (range === undefined || range[1] - range[0] + 1n <= limit) return undefined;
        return { error: { code: -32005, message: 'query exceeds max block range 3' } };
      },
    });
    const last = await world.token.sendTransfers(40, { perBlockMax: 2, random });
    await world.token.mine(2);
    const before = lines.length;

    indexer = await startInProcess(world.config({ RPC_HTTP_URL: proxy.url }), stream);
    await world.waitForCheckpoint(last, 60_000);

    const mine = lines.slice(before);
    expect(
      mine.some((line) => line.msg === 'range rejected by the RPC, retrying with a smaller batch'),
    ).toBe(true);
    for (const batch of mine.filter((line) => line.msg === 'batch indexed')) {
      expect(
        BigInt(String(batch.toBlock)) - BigInt(String(batch.fromBlock)) + 1n,
      ).toBeLessThanOrEqual(limit);
    }
    await exactParity();
  });

  it('rpc-lagging-node: a node behind answers [] and null above its height; no checkpoint passes it', async () => {
    const lagHeight = await world.token.publicClient.getBlockNumber();
    let lagging = true;
    proxy.setHooks({
      interceptCall: (call) => {
        if (!lagging) return undefined;
        if (call.method === 'eth_getLogs') {
          const range = logsRange(call);
          if (range !== undefined && range[1] > lagHeight) return { result: [] };
        }
        if (call.method === 'eth_getBlockByNumber') {
          const block = blockParam(call);
          if (block !== undefined && block > lagHeight) return { result: null };
        }
        // eth_blockNumber still comes from a node that is up to date, as behind a load balancer.
        return undefined;
      },
    });
    indexer = await startInProcess(world.config({ RPC_HTTP_URL: proxy.url }), stream);
    const last = await world.token.sendTransfers(30, { perBlockMax: 3, random });
    await world.token.mine(2);

    // Give the indexer time to try (and fail) the ranges above the lagging node.
    await delay(3000);
    expect((await world.repository.readCheckpoint())?.lastBlock).toBeLessThanOrEqual(lagHeight);
    expect(proxy.stats.intercepted).toBeGreaterThan(0);

    lagging = false;
    await world.waitForCheckpoint(last, 60_000);
    await exactParity();
  });
});
