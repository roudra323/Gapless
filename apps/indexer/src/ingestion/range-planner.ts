/** An inclusive block range. Both ends are processed. */
export type BlockRange = {
  readonly from: bigint;
  readonly to: bigint;
};

export type PlanInput = {
  /** The checkpoint's `last_block`: the last fully processed block. */
  readonly lastBlock: bigint;
  /** The latest chain head seen. */
  readonly head: bigint;
  readonly confirmations: bigint;
  /** The current batch size, at least 1 (see `batch-size.ts`). */
  readonly batchSize: bigint;
};

/**
 * The next range to index, or `null` when there is nothing confirmed to process yet.
 *
 * Only blocks `<= head - confirmations` are processed (docs/03 "Confirmed only"), and the range
 * always starts at `lastBlock + 1`, so consecutive ranges can never leave a gap.
 */
export function planNextRange({
  lastBlock,
  head,
  confirmations,
  batchSize,
}: PlanInput): BlockRange | null {
  if (batchSize < 1n) {
    throw new RangeError(`batchSize must be at least 1, got ${batchSize}`);
  }
  const target = head - confirmations;
  if (lastBlock >= target) return null;

  const from = lastBlock + 1n;
  const end = from + batchSize - 1n;
  return { from, to: end < target ? end : target };
}
