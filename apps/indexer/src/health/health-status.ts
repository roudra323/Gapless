/** The shortest liveness window (docs/03 "Health"). */
export const MIN_LIVENESS_WINDOW_MS = 60_000;

/**
 * The time after the last heartbeat in which the process still counts as live:
 * `max(60 s, 5 × POLL_INTERVAL_MS)`. A heartbeat comes at least once per poll interval, and once
 * per retry during an RPC outage, so only a hung or deadlocked process misses it.
 */
export function livenessWindowMs(pollIntervalMs: number): number {
  return Math.max(MIN_LIVENESS_WINDOW_MS, 5 * pollIntervalMs);
}

/** Liveness: a heartbeat within the window. It never depends on lag or on the RPC. */
export function isLive(lastBeatAt: number, now: number, pollIntervalMs: number): boolean {
  return now - lastBeatAt <= livenessWindowMs(pollIntervalMs);
}

/** Readiness: the process holds the advisory lock and the database answers. */
export function isReady(state: {
  readonly isLeader: boolean;
  readonly dbReachable: boolean;
}): boolean {
  return state.isLeader && state.dbReachable;
}
