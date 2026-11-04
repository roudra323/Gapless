import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiConfig } from '@gapless/config';
import { loggerOptions } from '@gapless/observability';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { HealthModule } from './health/health.module.js';
import { LifecycleService } from './lifecycle.service.js';
import { requestId } from './request-id.js';
import { SharedModule } from './shared.module.js';
import { StatsModule } from './stats/stats.module.js';
import { TransfersModule } from './transfers/transfers.module.js';

/** The `service` field on every log line of this process (docs/09 "Logs"). */
export const SERVICE_NAME = 'api';

@Module({})
export class AppModule {
  /**
   * The root module for a validated config. `logDestination` replaces stdout in tests, the same
   * way as in `createLogger` (packages/observability).
   */
  static forRoot(config: ApiConfig, logDestination?: DestinationStream): DynamicModule {
    const base = loggerOptions({
      service: SERVICE_NAME,
      version: config.APP_VERSION,
      level: config.LOG_LEVEL,
    });
    const options = {
      ...base,
      // Our `err` serializer must see the raw error, so pino-http must not wrap it (docs/09
      // "Logs"). Then pino-http adds no `req`/`res` serializers either, and we set short ones:
      // the raw objects are huge and hold every header.
      wrapSerializers: false,
      serializers: {
        ...base.serializers,
        req: (req: IncomingMessage) => ({ method: req.method, url: req.url }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      genReqId: requestId,
      // Log lines written during a request carry only `reqId`, not the whole request.
      quietReqLogger: true,
    };
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({ pinoHttp: logDestination ? [options, logDestination] : options }),
        SharedModule.forRoot(config),
        HealthModule,
        TransfersModule,
        StatsModule,
      ],
      providers: [
        // The one global exception filter, created with DI so it gets the logger (docs/05).
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        LifecycleService,
      ],
    };
  }
}
