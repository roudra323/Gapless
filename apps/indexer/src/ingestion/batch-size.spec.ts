import { describe, expect, it } from 'vitest';

import {
  afterRangeRejected,
  afterSuccess,
  type BatchSizeState,
  DOUBLE_AFTER_SUCCESSES,
  initialBatchSize,
} from './batch-size.js';

function repeat(state: BatchSizeState, times: number, step: typeof afterSuccess): BatchSizeState {
  let next = state;
  for (let i = 0; i < times; i++) next = step(next);
  return next;
}

describe('batch size', () => {
  it('starts at the configured maximum', () => {
    expect(initialBatchSize(2000n)).toEqual({ size: 2000n, max: 2000n, successes: 0 });
  });

  it('rejects a maximum below 1', () => {
    expect(() => initialBatchSize(0n)).toThrow(RangeError);
  });

  it('halves on a rejected range, down to 1 and no lower', () => {
    const sizes: bigint[] = [];
    let state = initialBatchSize(10n);
    for (let i = 0; i < 6; i++) {
      state = afterRangeRejected(state);
      sizes.push(state.size);
    }
    expect(sizes).toEqual([5n, 2n, 1n, 1n, 1n, 1n]);
  });

  it(`doubles only after ${DOUBLE_AFTER_SUCCESSES} consecutive successes`, () => {
    const halved = afterRangeRejected(initialBatchSize(2000n));
    expect(halved.size).toBe(1000n);

    const almost = repeat(halved, DOUBLE_AFTER_SUCCESSES - 1, afterSuccess);
    expect(almost.size).toBe(1000n);
    expect(almost.successes).toBe(DOUBLE_AFTER_SUCCESSES - 1);

    const doubled = afterSuccess(almost);
    expect(doubled).toEqual({ size: 2000n, max: 2000n, successes: 0 });
  });

  it('never grows above the maximum', () => {
    const state = { size: 1500n, max: 2000n, successes: 0 };
    expect(repeat(state, DOUBLE_AFTER_SUCCESSES, afterSuccess).size).toBe(2000n);
    expect(repeat(initialBatchSize(2000n), 50, afterSuccess).size).toBe(2000n);
  });

  it('sets the success count back to 0 on a rejection', () => {
    const state = repeat(afterRangeRejected(initialBatchSize(8n)), 7, afterSuccess);
    expect(state.successes).toBe(7);

    const rejected = afterRangeRejected(state);
    expect(rejected).toEqual({ size: 2n, max: 8n, successes: 0 });
    expect(repeat(rejected, DOUBLE_AFTER_SUCCESSES - 1, afterSuccess).size).toBe(2n);
  });

  it('grows back step by step from 1', () => {
    const one = repeat(initialBatchSize(5n), 5, afterRangeRejected);
    expect(one.size).toBe(1n);
    const sizes = [1, 2, 3].map((n) => repeat(one, n * DOUBLE_AFTER_SUCCESSES, afterSuccess).size);
    expect(sizes).toEqual([2n, 4n, 5n]);
  });
});
