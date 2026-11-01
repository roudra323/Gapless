import type { IndexerConfig } from '@gapless/config';
import { type DynamicModule, Module } from '@nestjs/common';

import { indexerConfigProvider } from '../config.provider.js';
import { dbHandleProvider, rpcClientProvider } from './ingestion.providers.js';
import { IngestionService } from './ingestion.service.js';

/** The ingestion feature: the RPC client, the database, and the service that runs the loop. */
@Module({})
export class IngestionModule {
  static forRoot(config: IndexerConfig): DynamicModule {
    return {
      module: IngestionModule,
      providers: [
        indexerConfigProvider(config),
        rpcClientProvider,
        dbHandleProvider,
        IngestionService,
      ],
      exports: [IngestionService],
    };
  }
}
