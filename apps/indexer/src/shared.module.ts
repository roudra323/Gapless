import type { IndexerConfig } from '@gapless/config';
import { type DynamicModule, Global, Module } from '@nestjs/common';

import { INDEXER_CONFIG, indexerConfigProvider } from './config.provider.js';
import { Heartbeat } from './health/heartbeat.js';
import {
  DB_HANDLE,
  dbHandleProvider,
  RPC_CLIENT,
  rpcClientProvider,
} from './ingestion/ingestion.providers.js';
import { LeaderStatus } from './leader/leader-status.js';
import { IndexerMetrics } from './metrics/indexer-metrics.js';

/**
 * The process-wide providers that more than one feature uses: the config, the RPC client, the
 * database pool, the heartbeat, the leader status and the metrics. Global, so the features import
 * nothing.
 */
@Global()
@Module({})
export class SharedModule {
  static forRoot(config: IndexerConfig): DynamicModule {
    return {
      module: SharedModule,
      providers: [
        indexerConfigProvider(config),
        rpcClientProvider,
        dbHandleProvider,
        { provide: Heartbeat, useFactory: () => new Heartbeat() },
        { provide: LeaderStatus, useFactory: () => new LeaderStatus() },
        // One registry per app instance (tests boot several in one process).
        { provide: IndexerMetrics, useFactory: () => new IndexerMetrics() },
      ],
      exports: [INDEXER_CONFIG, RPC_CLIENT, DB_HANDLE, Heartbeat, LeaderStatus, IndexerMetrics],
    };
  }
}
