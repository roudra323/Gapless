import { describe, expect, it } from 'vitest';

import { compareKeys, keyOf, MAX_REPORTED_KEYS } from './verify-range.js';

const range = { from: 1n, to: 10n };

describe('compareKeys', () => {
  it('reports parity for the same set in any order', () => {
    expect(compareKeys(range, ['0xa:0', '0xa:1', '0xb:0'], ['0xb:0', '0xa:1', '0xa:0'])).toEqual({
      from: 1n,
      to: 10n,
      chainCount: 3,
      dbCount: 3,
      missing: [],
      unexpected: [],
      duplicates: [],
      ok: true,
    });
  });

  it('copies only from and to from the range, never other input fields', () => {
    const input = { ...range, client: { secret: 'db-hunter2' } };
    expect(
      JSON.stringify(compareKeys(input, [], []), (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain('hunter2');
  });

  it('reports parity for an empty range', () => {
    expect(compareKeys(range, [], []).ok).toBe(true);
  });

  it('reports a gap as missing', () => {
    const report = compareKeys(range, ['0xa:0', '0xa:1'], ['0xa:0']);
    expect(report).toMatchObject({ ok: false, missing: ['0xa:1'], unexpected: [] });
  });

  it('reports a row the chain does not have as unexpected', () => {
    const report = compareKeys(range, ['0xa:0'], ['0xa:0', '0xdead:3']);
    expect(report).toMatchObject({ ok: false, missing: [], unexpected: ['0xdead:3'] });
  });

  it('reports a key the chain returned twice as a duplicate', () => {
    const report = compareKeys(range, ['0xa:0', '0xa:0'], ['0xa:0']);
    expect(report).toMatchObject({ ok: false, duplicates: ['0xa:0'] });
  });

  it('fails on a duplicate DB key, even though the primary key prevents it', () => {
    expect(compareKeys(range, ['0xa:0'], ['0xa:0', '0xa:0']).ok).toBe(false);
  });

  it(`lists at most ${MAX_REPORTED_KEYS} keys of each kind, but counts all`, () => {
    const chain = Array.from({ length: 50 }, (_, i) => `0xa:${i}`);
    const report = compareKeys(range, chain, []);
    expect(report.missing).toHaveLength(MAX_REPORTED_KEYS);
    expect(report.chainCount).toBe(50);
  });
});

describe('keyOf', () => {
  it('lowercases the hash, so the chain and the DB forms match', () => {
    expect(keyOf({ txHash: '0xABcd', logIndex: 7 })).toBe('0xabcd:7');
  });
});
