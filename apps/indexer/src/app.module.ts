import type { IndexerConfig } from '@gapless/config';
import { loggerOptions } from '@gapless/observability';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { indexerConfigProvider } from './config.provider.js';
import { LifecycleService } from './lifecycle.service.js';

/** The `service` field on every log line of this process (docs/09 "Logs"). */
export const SERVICE_NAME = 'indexer';

@Module({})
export class AppModule {
  /**
   * The root module for a validated config. `logDestination` replaces stdout in tests, the same
   * way as in `createLogger` (packages/observability).
   */
  static forRoot(config: IndexerConfig, logDestination?: DestinationStream): DynamicModule {
    const options = {
      ...loggerOptions({
        service: SERVICE_NAME,
        version: config.APP_VERSION,
        level: config.LOG_LEVEL,
      }),
      // pino-http wraps our `err` serializer as `errWithCause(stdErr(err))`, so it only sees an
      // already-serialized object and the inner errors of a cause are lost. This process has no
      // HTTP requests, so it needs none of pino-http's `req`/`res` serializers either.
      wrapSerializers: false,
    };
    return {
      module: AppModule,
      imports: [
        // nestjs-pino builds its one root logger on first use, so it works without an HTTP server.
        LoggerModule.forRoot({ pinoHttp: logDestination ? [options, logDestination] : options }),
      ],
      providers: [indexerConfigProvider(config), LifecycleService],
    };
  }
}
