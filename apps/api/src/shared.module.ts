import type { ApiConfig } from '@gapless/config';
import { type DynamicModule, Global, Module } from '@nestjs/common';

import { API_CONFIG, apiConfigProvider } from './config.provider.js';
import { DatabaseLifecycle, dbHandleProvider } from './database/database.providers.js';
import { DB_HANDLE } from './database/database.tokens.js';

/**
 * The process-wide providers that more than one feature uses: the config and the database pool.
 * Global, so the features import nothing (the same shape as the indexer's SharedModule).
 */
@Global()
@Module({})
export class SharedModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: SharedModule,
      providers: [apiConfigProvider(config), dbHandleProvider, DatabaseLifecycle],
      exports: [API_CONFIG, DB_HANDLE],
    };
  }
}
