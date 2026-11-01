import { describe, expect, it } from 'vitest';

import { backoffDelay, RETRY_BASE_MS, RETRY_MAX_MS } from './backoff.js';

const almostOne = () => 0.999_999;

describe('backoffDelay', () => {
  it('waits up to the base on the first retry', () => {
    expect(backoffDelay(0, almostOne)).toBe(RETRY_BASE_MS - 1);
  });

  it('doubles the ceiling on each attempt', () => {
    expect(backoffDelay(1, almostOne)).toBe(RETRY_BASE_MS * 2 - 1);
    expect(backoffDelay(3, almostOne)).toBe(RETRY_BASE_MS * 8 - 1);
  });

  it('never waits longer than the max', () => {
    expect(backoffDelay(10, almostOne)).toBe(RETRY_MAX_MS - 1);
    expect(backoffDelay(10_000, almostOne)).toBe(RETRY_MAX_MS - 1);
  });

  it('uses full jitter: a random value from 0 up to the ceiling', () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(5, () => 0.5)).toBe((RETRY_BASE_MS * 32) / 2);
  });

  it('is never negative or infinite', () => {
    for (const attempt of [-1, 0, 1, 50, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(RETRY_MAX_MS);
    }
  });
});
