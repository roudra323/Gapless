/** Consecutive successful batches before the batch size doubles (docs/03 "Batch size adaptation"). */
export const DOUBLE_AFTER_SUCCESSES = 10;

/** The adaptive batch size. Immutable: every function returns a new state. */
export type BatchSizeState = {
  /** Blocks per `getLogs` range now, between 1 and `max`. */
  readonly size: bigint;
  /** The configured `BATCH_SIZE`. The size never grows above it. */
  readonly max: bigint;
  /** Successful batches since the last change of `size`. */
  readonly successes: number;
};

/** Starts at the configured `BATCH_SIZE`. */
export function initialBatchSize(max: bigint): BatchSizeState {
  if (max < 1n) throw new RangeError(`max must be at least 1, got ${max}`);
  return { size: max, max, successes: 0 };
}

/** After a committed batch: double the size after enough consecutive successes, up to `max`. */
export function afterSuccess(state: BatchSizeState): BatchSizeState {
  if (state.size >= state.max) return { ...state, successes: 0 };

  const successes = state.successes + 1;
  if (successes < DOUBLE_AFTER_SUCCESSES) return { ...state, successes };

  const doubled = state.size * 2n;
  return { ...state, size: doubled < state.max ? doubled : state.max, successes: 0 };
}

/**
 * After the RPC rejected the range (too many results, response too large, timeout): halve the
 * size, minimum 1. The caller retries the same `from`, so no range is ever skipped.
 */
export function afterRangeRejected(state: BatchSizeState): BatchSizeState {
  const halved = state.size / 2n;
  return { ...state, size: halved > 1n ? halved : 1n, successes: 0 };
}
