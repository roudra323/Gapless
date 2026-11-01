import type { IndexerConfig } from '@gapless/config';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { INDEXER_CONFIG } from './config.provider.js';

/** Logs the start and the end of the process. `main.ts` starts the ingestion after boot. */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  // PinoLogger is resolved from the constructor type alone (no @Inject), so it must be a value
  // import: decorator metadata needs the class at runtime (docs/05 "TypeScript").
  constructor(
    private readonly logger: PinoLogger,
    @Inject(INDEXER_CONFIG) private readonly config: IndexerConfig,
  ) {
    logger.setContext(LifecycleService.name);
  }

  onApplicationBootstrap(): void {
    this.logger.info(
      {
        chainId: this.config.CHAIN_ID,
        tokenAddress: this.config.TOKEN_ADDRESS,
        // bigint → decimal string at the boundary (docs/05 "Blockchain values").
        startBlock: this.config.START_BLOCK.toString(),
      },
      'indexer started',
    );
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.info({ chainId: this.config.CHAIN_ID, signal }, 'indexer stopped');
  }
}
