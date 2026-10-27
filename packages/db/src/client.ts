import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

/** The typed Drizzle database. Repositories receive this, never the raw pool. */
export type Database = NodePgDatabase<typeof schema>;

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
  /** The underlying pool. Only for things Drizzle cannot do, such as a dedicated advisory-lock client (Phase 4). */
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
  });
  pool.on('error', options.onPoolError);

  const db = drizzle({ client: pool, schema });

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
