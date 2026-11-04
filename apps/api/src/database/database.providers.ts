import type { ApiConfig } from '@gapless/config';
import { createDb, type DbHandle } from '@gapless/db';
import {
  type FactoryProvider,
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { API_CONFIG } from '../config.provider.js';
import { DB_HANDLE } from './database.tokens.js';

/** The `application_name` in `pg_stat_activity`. */
export const DB_APPLICATION_NAME = 'gapless-api';

/**
 * A request waits at most this long for a database connection, then fails with 503. Without it,
 * `pg` waits forever when the host is unreachable, and requests pile up (packages/db `createDb`).
 */
export const DB_CONNECT_TIMEOUT_MS = 2000;

/** The pool is lazy: no connection opens before the first query. */
export const dbHandleProvider: FactoryProvider<DbHandle> = {
  provide: DB_HANDLE,
  inject: [API_CONFIG, PinoLogger],
  useFactory: (config: ApiConfig, logger: PinoLogger) =>
    createDb({
      url: config.DATABASE_URL,
      applicationName: DB_APPLICATION_NAME,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      // An idle connection failed (for example, Postgres restarted). The pool replaces it; the
      // next request that fails answers 503 until the database is back.
      onPoolError: (err) => logger.error({ err }, 'idle database connection failed'),
    }),
};

/**
 * Closes the pool at shutdown. Nest runs `onApplicationShutdown` after it closed the HTTP server,
 * so no request still needs the pool.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
