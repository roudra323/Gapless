import { describe, expect, it } from 'vitest';

import { isDatabaseReachable } from './database-check.js';

describe('isDatabaseReachable', () => {
  it('is true when select 1 answers', async () => {
    expect(await isDatabaseReachable({ query: () => Promise.resolve({ rows: [] }) })).toBe(true);
  });

  it('is false when the query fails, and does not reject', async () => {
    const pool = { query: () => Promise.reject(new Error('connect ECONNREFUSED')) };
    expect(await isDatabaseReachable(pool)).toBe(false);
  });

  it('is false when the query is slower than the timeout', async () => {
    const pool = { query: () => new Promise<never>(() => {}) };
    const started = Date.now();

    expect(await isDatabaseReachable(pool, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
