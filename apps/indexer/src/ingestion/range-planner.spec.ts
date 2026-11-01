import { describe, expect, it } from 'vitest';

import { planNextRange } from './range-planner.js';

const base = { lastBlock: 99n, head: 1000n, confirmations: 5n, batchSize: 100n };

describe('planNextRange', () => {
  it('starts at lastBlock + 1 and spans batchSize blocks', () => {
    expect(planNextRange(base)).toEqual({ from: 100n, to: 199n });
  });

  it('stops at head - confirmations for the last short range', () => {
    expect(planNextRange({ ...base, lastBlock: 950n })).toEqual({ from: 951n, to: 995n });
  });

  it('returns a full range that ends exactly on the target', () => {
    expect(planNextRange({ ...base, lastBlock: 895n })).toEqual({ from: 896n, to: 995n });
  });

  it('returns a one-block range when only one confirmed block is new', () => {
    expect(planNextRange({ ...base, lastBlock: 994n })).toEqual({ from: 995n, to: 995n });
  });

  it('returns null when the checkpoint is at the target', () => {
    expect(planNextRange({ ...base, lastBlock: 995n })).toBeNull();
  });

  it('returns null when the checkpoint is above the target (head went back)', () => {
    expect(planNextRange({ ...base, lastBlock: 999n })).toBeNull();
  });

  it('returns null when the head is below the confirmations', () => {
    expect(planNextRange({ ...base, lastBlock: 0n, head: 3n })).toBeNull();
  });

  it('includes the head itself with CONFIRMATIONS=0', () => {
    expect(planNextRange({ ...base, lastBlock: 990n, confirmations: 0n })).toEqual({
      from: 991n,
      to: 1000n,
    });
  });

  it('works with a batch size of 1', () => {
    expect(planNextRange({ ...base, batchSize: 1n })).toEqual({ from: 100n, to: 100n });
  });

  it('keeps exact values above 2^53', () => {
    const lastBlock = 2n ** 53n + 1n;
    expect(
      planNextRange({ lastBlock, head: lastBlock + 10n, confirmations: 0n, batchSize: 3n }),
    ).toEqual({ from: 2n ** 53n + 2n, to: 2n ** 53n + 4n });
  });

  it('rejects a batch size below 1', () => {
    expect(() => planNextRange({ ...base, batchSize: 0n })).toThrow(RangeError);
  });
});
