import type { ApiConfig } from '@gapless/config';
import { type DynamicModule, Global, Module } from '@nestjs/common';

import { API_CONFIG, apiConfigProvider } from './config.provider.js';
import { DatabaseLifecycle, dbHandleProvider } from './database/database.providers.js';
import { DB_HANDLE } from './database/database.tokens.js';
import { ApiMetrics } from './metrics/api-metrics.js';

/**
 * The process-wide providers that more than one feature uses: the config, the database pool and
 * the metrics.
 * Global, so the features import nothing (the same shape as the indexer's SharedModule).
 */
@Global()
@Module({})
export class SharedModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: SharedModule,
      providers: [
        apiConfigProvider(config),
        dbHandleProvider,
        DatabaseLifecycle,
        // One registry per app instance (tests boot several in one process).
        { provide: ApiMetrics, useFactory: () => new ApiMetrics() },
      ],
      exports: [API_CONFIG, DB_HANDLE, ApiMetrics],
    };
  }
}
