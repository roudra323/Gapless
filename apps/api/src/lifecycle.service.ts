import type { ApiConfig } from '@gapless/config';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { API_CONFIG } from './config.provider.js';

/** Logs the start and the end of the process. */
@Injectable()
export class LifecycleService implements OnApplicationShutdown {
  // PinoLogger is resolved from the constructor type alone, so it is a value import (docs/05).
  constructor(
    private readonly logger: PinoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    logger.setContext(LifecycleService.name);
  }

  /** Called by `main.ts` once the HTTP server listens. */
  started(port: number): void {
    this.logger.info(
      { port, chainId: this.config.CHAIN_ID, tokenAddress: this.config.TOKEN_ADDRESS },
      'api started',
    );
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'api stopped');
  }
}
