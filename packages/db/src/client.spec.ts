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
    });
    expect(handle.pool.options.max).toBe(3);
    expect(handle.pool.options.application_name).toBe('gapless-test');
    expect(handle.pool.options.keepAlive).toBe(true);
    await handle.close();
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
