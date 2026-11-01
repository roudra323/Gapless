import { createServer, type Server, type Socket, connect } from 'node:net';

export type TcpProxy = {
  /** `host:port` of the proxy. Use it as `ws://${address}` or `http://${address}`. */
  readonly address: string;
  /** Destroys every open connection (both sides), as a network drop does. */
  readonly dropAll: () => void;
  /** New connections are destroyed at once until `resume`. Open ones are not touched. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** Connections accepted so far (including refused ones while paused). */
  readonly connections: () => number;
  readonly close: () => Promise<void>;
};

/**
 * A plain TCP pipe to `targetUrl`'s host and port. It knows nothing about HTTP or WebSocket, so
 * a drop looks like a real network failure to the client.
 */
export async function startTcpProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl);
  const open = new Set<Socket>();
  let paused = false;
  let accepted = 0;

  const server: Server = createServer((client) => {
    accepted += 1;
    if (paused) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port), target.hostname);
    open.add(client);
    open.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');

  return {
    address: `127.0.0.1:${address.port}`,
    dropAll: () => {
      for (const socket of open) socket.destroy();
      open.clear();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    connections: () => accepted,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
