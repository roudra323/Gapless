import type { LeaderSession } from '../leader/leader-lock.js';

/** A standby tries to take the lock this often (docs/03 "Leader"). */
export const LEADER_RETRY_MS = 5000;

export type SupervisorDeps = {
  readonly lock: { readonly tryAcquire: () => Promise<LeaderSession | null> };
  /** A new ingestion loop whose store writes through `session.db` (the lock connection). */
  readonly createLoop: (session: LeaderSession) => { run: (signal: AbortSignal) => Promise<void> };
  readonly heartbeat: { readonly beat: () => void };
  readonly leaderStatus: { readonly set: (isLeader: boolean) => void };
  readonly logger: {
    readonly info: (fields: Record<string, unknown>, message: string) => void;
    readonly warn: (fields: Record<string, unknown>, message: string) => void;
  };
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly retryMs?: number;
};

/**
 * Runs ingestion only while this process holds the advisory lock (docs/03 "Leader").
 *
 * - Not leader: beat the heartbeat (a standby is live, only not ready), wait, try again.
 * - Leader: run one loop with a signal that aborts on shutdown or when the lock connection fails.
 *   When the lock is lost, give up leadership and go back to waiting; never reuse the session.
 * - A fatal error from the loop releases the lock and rejects `run`.
 */
export class IndexerSupervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  /** Runs until `shutdown` aborts (resolves) or a fatal error (rejects). */
  async run(shutdown: AbortSignal): Promise<void> {
    const { lock, createLoop, heartbeat, leaderStatus, logger, wait } = this.deps;
    const retryMs = this.deps.retryMs ?? LEADER_RETRY_MS;
    let standbyLogged = false;

    while (!shutdown.aborted) {
      heartbeat.beat();
      let session: LeaderSession | null;
      try {
        session = await lock.tryAcquire();
      } catch (err) {
        // pg errors don't hold the connection string, so `err` is safe to log.
        logger.warn({ err }, 'leader lock attempt failed, retrying');
        await wait(retryMs, shutdown);
        continue;
      }
      if (session === null) {
        if (!standbyLogged) logger.info({}, 'another instance is the leader, waiting');
        standbyLogged = true;
        await wait(retryMs, shutdown);
        continue;
      }
      if (shutdown.aborted) {
        await session.release();
        break;
      }

      standbyLogged = false;
      leaderStatus.set(true);
      logger.info({}, 'leadership acquired');
      try {
        await createLoop(session).run(AbortSignal.any([shutdown, session.lost]));
      } finally {
        leaderStatus.set(false);
        await session.release();
      }
      if (session.lost.aborted && !shutdown.aborted) {
        logger.warn({}, 'leadership lost, waiting to acquire it again');
      }
    }
  }
}
