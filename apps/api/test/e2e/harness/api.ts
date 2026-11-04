import 'reflect-metadata';

import type { Server } from 'node:http';

import type { ApiConfig } from '@gapless/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from '../../../src/app.module.js';
import { HealthService } from '../../../src/health/health.service.js';
import { CHAIN_ID, TOKEN } from '../../integration/harness/seed.js';

export type LogLine = Record<string, unknown>;

export type TestApi = {
  /** The Nest HTTP server, for supertest. */
  readonly server: Server;
  /** `http://127.0.0.1:<METRICS_PORT>`, where `/healthz` and `/readyz` live. */
  readonly healthUrl: string;
  /** Every JSON log line the app wrote, in order. */
  readonly logs: readonly LogLine[];
  readonly close: () => Promise<void>;
};

/**
 * Boots the whole API in-process, the same way as `src/main.ts` (minus the signal handlers), on
 * free ports and against `databaseUrl`. nestjs-pino keeps one root logger per module graph, so
 * boot one app per test file.
 */
export async function startApi(databaseUrl: string): Promise<TestApi> {
  const config: ApiConfig = {
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'info',
    APP_VERSION: 'e2e',
    CHAIN_ID,
    TOKEN_ADDRESS: TOKEN,
    SHUTDOWN_TIMEOUT_MS: 20_000,
    METRICS_PORT: 0,
    PORT: 0,
  };
  const logs: LogLine[] = [];
  const destination = { write: (line: string) => logs.push(JSON.parse(line) as LogLine) };

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, destination),
    { bufferLogs: true, abortOnError: false },
  );
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  await app.listen(0, '127.0.0.1');

  return {
    server: app.getHttpServer() as Server,
    healthUrl: `http://127.0.0.1:${app.get(HealthService).port()}`,
    logs,
    close: () => app.close(),
  };
}

/**
 * Polls `check` until it returns true, or fails after `timeoutMs` (docs/06 "Rules": no sleeps
 * for synchronization).
 */
export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
