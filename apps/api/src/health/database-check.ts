import { setTimeout as delay } from 'node:timers/promises';

/** A readiness probe must answer fast; a database slower than this counts as unreachable. */
export const DB_CHECK_TIMEOUT_MS = 2000;

/** The one `pg` pool method the check needs, so a test can pass a small fake. */
export type Pingable = {
  readonly query: (text: string) => Promise<unknown>;
};

/**
 * `select 1` within `timeoutMs` (docs/03 "Health", the same check as the indexer). Never rejects:
 * any error or a timeout is `false`, because a probe only needs yes or no.
 */
export async function isDatabaseReachable(
  pool: Pingable,
  timeoutMs = DB_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      pool.query('select 1').then(
        () => true,
        () => false,
      ),
      // The timer is cancelled when the query wins, so it never keeps the process alive.
      delay(timeoutMs, false, { signal: abort.signal }).catch(() => false),
    ]);
  } finally {
    abort.abort();
  }
}
