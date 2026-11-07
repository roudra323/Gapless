import { createRpcClient } from '@gapless/chain';
import type { IndexerConfig } from '@gapless/config';
import { createDb, type DbHandle } from '@gapless/db';
import type { FactoryProvider } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { PublicClient } from 'viem';

import { INDEXER_CONFIG } from '../config.provider.js';
import { IndexerMetrics } from '../metrics/indexer-metrics.js';

/** DI token for the viem HTTP client (`createRpcClient`, packages/chain), with the RPC metrics. */
export const RPC_CLIENT = Symbol('RPC_CLIENT');

/** DI token for the Postgres pool and its Drizzle instance (`createDb`, packages/db). */
export const DB_HANDLE = Symbol('DB_HANDLE');

/** The `application_name` in `pg_stat_activity`. */
export const DB_APPLICATION_NAME = 'gapless-indexer';

export const rpcClientProvider: FactoryProvider<PublicClient> = {
  provide: RPC_CLIENT,
  inject: [INDEXER_CONFIG, IndexerMetrics],
  useFactory: (config: IndexerConfig, metrics: IndexerMetrics) =>
    createRpcClient({ url: config.RPC_HTTP_URL, onCall: (call) => metrics.recordRpcCall(call) }),
};

/** The pool is lazy: no connection opens before the first query. `IngestionService` closes it. */
export const dbHandleProvider: FactoryProvider<DbHandle> = {
  provide: DB_HANDLE,
  inject: [INDEXER_CONFIG, PinoLogger],
  useFactory: (config: IndexerConfig, logger: PinoLogger) =>
    createDb({
      url: config.DATABASE_URL,
      applicationName: DB_APPLICATION_NAME,
      // An idle connection failed (for example, Postgres restarted). The pool replaces it, and
      // the next query that fails is retried by the loop.
      onPoolError: (err) => logger.error({ err }, 'idle database connection failed'),
    }),
};
