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

beforeAll(async () => {
  world = await startWorld();
  proxy = await startTcpProxy(world.anvil.rpcUrl);
});

afterEach(async () => {
  // Also after a failed test, so the next test starts with no indexer running.
  await indexer?.stop();
  indexer = undefined;
  proxy.resume();
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
    await waitFor(() => count('ws head feed connected') === 1, {
      timeoutMs: 10_000,
      description: 'the socket is up',
    });
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
    const connectedBefore = count('ws head feed connected');
    await waitFor(() => count('ws head feed connected') > connectedBefore, {
      timeoutMs: 10_000,
      description: 'the socket is up',
    });

    // Cut the socket and refuse new ones. Transfers go on.
    proxy.pause();
    proxy.dropAll();
    await waitFor(() => count('ws head feed lost') >= 1, {
      timeoutMs: 10_000,
      description: 'the drop is seen',
    });
    const whileDown = await world.token.sendTransfers(40, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(whileDown, 20_000);
    // The tracker keeps trying (with backoff) while new sockets are refused.
    await waitFor(() => count('ws head feed failed to connect') > 0, {
      timeoutMs: 10_000,
      description: 'a refused reconnect',
    });

    // Let the socket back in: the tracker subscribes again with its own backoff.
    const reconnects = count('ws head feed connected');
    proxy.resume();
    await waitFor(() => count('ws head feed connected') > reconnects, {
      timeoutMs: 40_000,
      description: 'the socket reconnects',
    });
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

  it('no-ws: with RPC_WS_URL unset it indexes by polling alone', async () => {
    const wsLines = count('ws head feed connected');
    indexer = await startInProcess(world.config({ RPC_WS_URL: undefined }), stream);
    const last = await world.token.sendTransfers(30, { perBlockMax: 4, random });
    await world.token.mine(2);
    await world.waitForCheckpoint(last);
    await indexer.stop();
    indexer = undefined;

    expect(count('ws head feed connected')).toBe(wsLines);
    const report = await world.parity();
    expect(report).toMatchObject({ ok: true, chainCount: 1 + 10 + 40 + 20 + 30 });
    expect(lines.some((line) => line.level === 'fatal' || line.level === 'error')).toBe(false);
  });
});
