import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { RpcCall } from './rpc-observer.js';
import { subscribeNewHeads, WebSocketSubscribeTimeoutError } from './ws-client.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A TCP server that accepts connections and never answers: a black-holed WebSocket. */
async function silentServer(): Promise<string> {
  const server = createServer((socket) => sockets.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('subscribeNewHeads', () => {
  it('gives up when the socket never opens, instead of waiting forever', async () => {
    const url = await silentServer();
    const calls: RpcCall[] = [];
    const started = Date.now();

    await expect(
      subscribeNewHeads({
        url,
        onHead: () => undefined,
        onError: () => undefined,
        timeoutMs: 100,
        onCall: (call) => calls.push(call),
      }),
    ).rejects.toBeInstanceOf(WebSocketSubscribeTimeoutError);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toEqual([
      expect.objectContaining({ method: 'eth_subscribe', transport: 'ws', result: 'error' }),
    ]);
  });

  it('rejects when nothing listens on the port', async () => {
    const url = await silentServer();
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));

    await expect(
      subscribeNewHeads({
        url,
        onHead: () => undefined,
        onError: () => undefined,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();
  });
});
