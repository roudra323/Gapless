import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import * as schema from './schema.js';

/** The typed Drizzle database. Repositories receive this, never the raw pool. */
export type Database = NodePgDatabase<typeof schema>;

/** One connection checked out of the pool (re-exported, so apps don't import `pg` directly). */
export type DbClient = PoolClient;

export type CreateDbOptions = {
  /** A `postgres://` URL, already validated by `@gapless/config`. */
  readonly url: string;
  /**
   * Called when an idle pooled connection fails (for example, Postgres restarts).
   * Required: without a listener, `pg` emits an unhandled `error` event and the process crashes.
   */
  readonly onPoolError: (err: Error) => void;
  /** Upper bound on open connections. Defaults to 10 (the `pg` default). */
  readonly maxConnections?: number;
  /** Shown in `pg_stat_activity.application_name`, so you can see which process holds a connection. */
  readonly applicationName?: string;
};

export type DbHandle = {
  readonly db: Database;
  /** The underlying pool. Only for things Drizzle cannot do, such as the dedicated advisory-lock client. */
  readonly pool: Pool;
  /** Closes every connection in the pool. Call it once, at shutdown. */
  readonly close: () => Promise<void>;
};

/**
 * Creates a connection pool and a typed Drizzle instance on top of it.
 * The pool is lazy: no connection is opened until the first query.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName,
    // TCP keepalive, so a peer that vanished without closing the socket is noticed. The
    // indexer holds one connection for its whole life (the advisory lock, docs/03 "Leader").
    keepAlive: true,
  });
  pool.on('error', options.onPoolError);

  const db = drizzle({ client: pool, schema });

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/**
 * A typed Drizzle instance on one checked-out connection. Every query and transaction runs in that
 * one Postgres session, which is what the indexer's leader needs: its writes and its advisory lock
 * must share a session (docs/03 "Leader"). The caller owns the client and releases it.
 */
export function createSessionDb(client: DbClient): Database {
  return drizzle({ client, schema });
}
