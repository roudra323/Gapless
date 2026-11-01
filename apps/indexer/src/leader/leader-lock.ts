import { createSessionDb, type Database, type DbClient } from '@gapless/db';
import { sql } from 'drizzle-orm';

/** Leadership while it lasts: the lock connection's Drizzle instance and a "lost" signal. */
export type LeaderSession = {
  /** Every write of the leader goes through this instance, in the session that holds the lock. */
  readonly db: Database;
  /** Aborts when the lock connection fails. The lock is gone then: stop writing. */
  readonly lost: AbortSignal;
  /** Unlocks and returns the connection to the pool. Safe to call more than once. */
  readonly release: () => Promise<void>;
};

/** What the lock needs from the pool (`pg.Pool`). */
export type LockPool = {
  readonly connect: () => Promise<DbClient>;
};

export type LeaderLockLogger = {
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * The single-writer lock (docs/03 "Leader"): a Postgres session-level advisory lock, held on one
 * dedicated connection for as long as the process leads.
 *
 * All writes run on that same connection (`LeaderSession.db`). If the connection drops, Postgres
 * releases the lock and rolls back the open transaction together, so a former leader can never
 * commit after a new leader starts.
 */
export class LeaderLock {
  constructor(
    private readonly pool: LockPool,
    private readonly key: bigint,
    private readonly logger: LeaderLockLogger,
  ) {}

  /** Takes the lock, or returns `null` when another session holds it. Throws on a DB error. */
  async tryAcquire(): Promise<LeaderSession | null> {
    const client = await this.pool.connect();
    const lost = new AbortController();
    let released = false;

    // The pool's 'error' listener covers idle clients only. A checked-out client needs its own,
    // or a dropped socket crashes the process (docs/03 "Leader").
    const onError = (err: Error): void => {
      if (released) return;
      released = true;
      this.logger.warn({ err }, 'leader lock connection failed');
      lost.abort(err);
      // Passing the error destroys the connection instead of returning it to the pool.
      client.release(err);
    };
    // A query that is running when the server ends the session gets the error itself, and the
    // client then only emits 'end'. That loses the lock too.
    const onEnd = (): void => onError(new Error('the leader lock connection ended'));
    client.on('error', onError);
    client.on('end', onEnd);

    const giveBack = (err?: Error): void => {
      if (released) return;
      released = true;
      // A connection that goes back to the pool must not keep our listeners.
      if (err === undefined) {
        client.off('error', onError);
        client.off('end', onEnd);
      }
      client.release(err);
    };

    const db = createSessionDb(client);
    let locked: boolean;
    try {
      const result = await db.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_lock(${this.key.toString()}::bigint) as locked`,
      );
      locked = result.rows[0]?.locked === true;
    } catch (err) {
      giveBack(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    if (!locked) {
      giveBack();
      return null;
    }

    return {
      db,
      lost: lost.signal,
      release: async () => {
        if (released) return;
        try {
          await db.execute(sql`select pg_advisory_unlock(${this.key.toString()}::bigint)`);
          giveBack();
        } catch (err) {
          // Never reuse a connection in an unknown state: destroy it. Postgres frees the lock
          // when the session ends.
          giveBack(err instanceof Error ? err : new Error(String(err)));
        }
      },
    };
  }
}
