/** The first retry waits up to this long (docs/03 "Retry policy"). */
export const RETRY_BASE_MS = 500;

/** No retry waits longer than this. */
export const RETRY_MAX_MS = 30_000;

/** Past this exponent `base * 2^n` is above the cap anyway; stopping here keeps it finite. */
const MAX_EXPONENT = 30;

/**
 * The wait before retry number `attempt` (0 for the first retry): exponential backoff with full
 * jitter, a random value in `[0, min(RETRY_MAX_MS, RETRY_BASE_MS * 2^attempt))`.
 *
 * Full jitter spreads the retries of many clients, so they don't hit a recovering RPC at the same
 * moment. Transient errors are retried forever; only this wait grows.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 0), MAX_EXPONENT);
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
  return Math.floor(random() * ceiling);
}
