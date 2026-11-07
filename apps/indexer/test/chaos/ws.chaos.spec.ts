import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTcpProxy, type TcpProxy } from '../integration/harness/tcp-proxy.js';
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
let proxy: TcpProxy;
let indexer: InProcessIndexer | undefined;
const random = seededRandom(23);
// One capture for the whole file: nestjs-pino's first destination wins (see world.ts).
const { lines, stream } = captureLogs();
const count = (msg: string) => lines.filter((line) => line.msg === msg).length;

/** `gapless_indexer_ws_connected` and `ws_reconnects_total` of the running indexer. */
async function wsMetrics(running: InProcessIndexer) {
  const metrics = await running.metrics();
  return {
    connected: metrics.get('gapless_indexer_ws_connected'),
    reconnects: metrics.get('gapless_indexer_ws_reconnects_total') ?? 0,
    wsCalls: metrics.sum('gapless_rpc_requests_total', { transport: 'ws' }),
  };
}

async function waitForWs(
  running: InProcessIndexer,
  check: (ws: Awaited<ReturnType<typeof wsMetrics>>) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(async () => check(await wsMetrics(running)), { timeoutMs, description });
}

beforeAll(async () => {
  world = await startWorld();
  proxy = await startTcpProxy(world.anvil.rpcUrl);
});

afterEach(async () => {
  // Also after a failed test, so the next test starts with no indexer running.
  await indexer?.stop();
  indexer = undefined;
  proxy.resume();
  proxy.unsilence();
});

afterAll(async () => {
  await proxy?.close();
  await world?.stop();
});

describe('ws head trigger', () => {
  it('ws-trigger: a new head on the socket wakes the loop long before the poll would', async () => {
    // The poll runs once at start, then only every 60 s: any fast progress comes from the socket.
    indexer = await startInProcess(
      world.config({
        CONFIRMATIONS: 0n,
        POLL_INTERVAL_MS: 60_000,
        RPC_WS_URL: `ws://${proxy.address}`,
      }),
      stream,
    );
    await waitForWs(indexer, (ws) => ws.connected === 1, 'ws_connected is 1');
    expect((await wsMetrics(indexer)).wsCalls).toBeGreaterThan(0); // eth_subscribe
    await waitFor(async () => (await world.repository.readCheckpoint()) !== null, {
      timeoutMs: 10_000,
      description: 'the first checkpoint',
    });

    const last = await world.token.sendTransfers(10, { perBlockMax: 3, random });
    const sent = Date.now();
    await world.waitForCheckpoint(last, 10_000);
    expect(Date.now() - sent).toBeLessThan(5000);

    await indexer.stop();
    indexer = undefined;
    expect(await world.parity()).toMatchObject({ ok: true });
  });

  it('ws-drop: indexing goes on through the poll while the socket is down, then it reconnects', async () => {
    indexer = await startInProcess(
      world.config({ POLL_INTERVAL_MS: 200, RPC_WS_URL: `ws://${proxy.address}` }),
      stream,
    );
    const running = indexer;
    await waitForWs(running, (ws) => ws.connected === 1, 'ws_connected is 1');

    // Cut the socket and refuse new ones. Transfers go on.
    proxy.pause();
    proxy.dropAll();
    await waitForWs(running, (ws) => ws.connected === 0, 'ws_connected drops to 0');
    expect(count('ws head feed lost')).toBeGreaterThanOrEqual(1);
    const whileDown = await world.token.sendTransfers(40, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(whileDown, 20_000);
    // The tracker keeps trying (with backoff) while new sockets are refused.
    await waitForWs(running, (ws) => ws.reconnects >= 2, 'refused reconnects are counted');
    expect((await wsMetrics(running)).connected).toBe(0);

    // Let the socket back in: the tracker subscribes again with its own backoff.
    proxy.resume();
    await waitForWs(running, (ws) => ws.connected === 1, 'ws_connected is 1 again', 40_000);
    const after = await world.token.sendTransfers(20, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(after);

    await indexer.stop();
    indexer = undefined;
    expect(await world.parity()).toMatchObject({
      ok: true,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
  });

  it('ws-stall: a socket that stays up but delivers no heads is dropped and reconnects', async () => {
    // Stall after 3 × 200 ms behind the poll.
    indexer = await startInProcess(
      world.config({
        POLL_INTERVAL_MS: 100,
        BLOCK_TIME_MS: 200,
        RPC_WS_URL: `ws://${proxy.address}`,
      }),
      stream,
    );
    const running = indexer;
    await waitForWs(running, (ws) => ws.connected === 1, 'ws_connected is 1');
    const stallsBefore = count('ws head feed stalled, reconnecting');

    // The socket stays open but goes silent; the chain moves on, so the poll gets ahead of it.
    proxy.silence();
    const whileSilent = await world.token.sendTransfers(20, { perBlockMax: 4, random });
    await world.token.mine(2);
    await waitForWs(running, (ws) => ws.connected === 0, 'the stall drops ws_connected to 0');
    expect(count('ws head feed stalled, reconnecting')).toBeGreaterThan(stallsBefore);
    await waitForWs(running, (ws) => ws.reconnects >= 1, 'the stall causes a reconnect');
    // Progress never depended on the socket.
    await world.waitForCheckpoint(whileSilent, 20_000);

    proxy.unsilence();
    await waitForWs(running, (ws) => ws.connected === 1, 'ws_connected is 1 again', 40_000);
    const after = await world.token.sendTransfers(10, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(after);

    await indexer.stop();
    indexer = undefined;
    expect(await world.parity()).toMatchObject({
      ok: true,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
  });

  it('no-ws: with RPC_WS_URL unset it indexes by polling alone', async () => {
    const wsLines = count('ws head feed connected');
    indexer = await startInProcess(world.config({ RPC_WS_URL: undefined }), stream);
    const last = await world.token.sendTransfers(30, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(last);
    // Poll-only: the gauge stays 0 and nothing reconnects.
    expect(await wsMetrics(indexer)).toEqual({ connected: 0, reconnects: 0, wsCalls: 0 });
    await indexer.stop();
    indexer = undefined;

    expect(count('ws head feed connected')).toBe(wsLines);
    const report = await world.parity();
    expect(report).toMatchObject({ ok: true, chainCount: 1 + 10 + 40 + 20 + 20 + 10 + 30 });
    expect(lines.some((line) => line.level === 'fatal' || line.level === 'error')).toBe(false);
  });
});
