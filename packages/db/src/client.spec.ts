import { type AddressInfo, createServer, type Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createDb, createSessionDb, type DbClient } from './client.js';

// Port 1 is never a Postgres server. These tests prove that createDb does not connect.
const UNREACHABLE_URL = 'postgres://gapless:gapless@127.0.0.1:1/gapless';

describe('createDb', () => {
  it('does not open a connection until the first query', async () => {
    const handle = createDb({ url: UNREACHABLE_URL, onPoolError: vi.fn() });
    expect(handle.pool.totalCount).toBe(0);
    await handle.close();
  });

  it('applies the pool options', async () => {
    const handle = createDb({
      url: UNREACHABLE_URL,
      onPoolError: vi.fn(),
      maxConnections: 3,
      applicationName: 'gapless-test',
      connectionTimeoutMillis: 2000,
    });
    expect(handle.pool.options.max).toBe(3);
    expect(handle.pool.options.connectionTimeoutMillis).toBe(2000);
    expect(handle.pool.options.application_name).toBe('gapless-test');
    expect(handle.pool.options.keepAlive).toBe(true);
    await handle.close();
  });

  it('keeps the pg default (no connection timeout) when unset', async () => {
    const handle = createDb({ url: UNREACHABLE_URL, onPoolError: vi.fn() });
    expect(handle.pool.options.connectionTimeoutMillis).toBe(0);
    await handle.close();
  });

  it('fails a query after connectionTimeoutMillis instead of waiting forever', async () => {
    // A server that accepts the TCP connection and never answers: like a host that is up but
    // stuck. Without the timeout, the query would wait forever.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;

    const handle = createDb({
      url: `postgres://gapless:gapless@127.0.0.1:${port}/gapless`,
      onPoolError: vi.fn(),
      connectionTimeoutMillis: 200,
    });
    const started = Date.now();
    await expect(handle.pool.query('select 1')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2000);

    await handle.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it('sends idle-client errors to onPoolError instead of crashing', async () => {
    const onPoolError = vi.fn();
    const handle = createDb({ url: UNREACHABLE_URL, onPoolError });
    const err = new Error('terminating connection due to administrator command');
    handle.pool.emit('error', err);
    expect(onPoolError).toHaveBeenCalledWith(err);
    await handle.close();
  });

  it('close() ends the pool', async () => {
    const handle = createDb({ url: UNREACHABLE_URL, onPoolError: vi.fn() });
    await handle.close();
    expect(handle.pool.ended).toBe(true);
  });
});

describe('createSessionDb', () => {
  it('sends every query of the instance to the one client it was given', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0, fields: [] });
    const client = { query } as unknown as DbClient;
    await createSessionDb(client).execute('select 1');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
