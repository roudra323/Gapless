import { Agent, createServer, request, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { configureHttpServer, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from './http-server.js';

/**
 * When Node closes an idle socket by default: `keepAliveTimeout` (5 s) plus Node 24's
 * `keepAliveTimeoutBuffer` (1 s). The value that caused the 503s behind Envoy.
 */
const NODE_DEFAULT_IDLE_CLOSE_MS = 6_000;

let server: Server | undefined;
let agent: Agent | undefined;

afterEach(async () => {
  agent?.destroy();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = agent = undefined;
});

/** A server with the API's timeouts that answers 200 and counts the TCP connections. */
async function start(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  server = createServer((_req, res) => res.end('ok'));
  server.on('connection', (_socket: Socket) => connections++);
  configureHttpServer(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

function get(port: number): Promise<{ status: number; keepAlive: string | undefined }> {
  return new Promise((resolve, reject) => {
    request({ port, host: '127.0.0.1', path: '/', agent }, (res) => {
      res.resume();
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, keepAlive: res.headers['keep-alive']?.toString() }),
      );
    })
      .on('error', reject)
      .end();
  });
}

describe('configureHttpServer', () => {
  it('keeps idle connections longer than the proxy, with the headers timer above it', () => {
    // Envoy's upstream idle timeout is 60 s (chart value gateway.upstreamIdleTimeout).
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it('tells clients the keep-alive timeout in the Keep-Alive header', async () => {
    const { port } = await start();
    agent = new Agent({ keepAlive: true });
    expect(await get(port)).toEqual({ status: 200, keepAlive: 'timeout=65' });
  });

  it(
    'still has the connection open after the old idle close time, and reuses it',
    { timeout: 15_000 },
    async () => {
      const { port, connections } = await start();
      agent = new Agent({ keepAlive: true, maxSockets: 1 });

      await get(port);
      // Longer than Node's default: without configureHttpServer the server closes the socket
      // here, and the second request needs a new connection.
      await sleep(NODE_DEFAULT_IDLE_CLOSE_MS + 500);
      expect((await get(port)).status).toBe(200);

      expect(connections()).toBe(1);
    },
  );
});
