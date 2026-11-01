import 'reflect-metadata';

import type { IndexerConfig } from '@gapless/config';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { LifecycleService } from './lifecycle.service.js';

const TEST_CONFIG: IndexerConfig = {
  DATABASE_URL: 'postgres://gapless:db-hunter2@localhost:15432/gapless',
  LOG_LEVEL: 'info',
  APP_VERSION: 'test-sha',
  CHAIN_ID: 31337,
  TOKEN_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  RPC_HTTP_URL: 'http://localhost:8545/v2/rpc-hunter2',
  START_BLOCK: 9007199254740993n,
  CONFIRMATIONS: 5n,
  BATCH_SIZE: 2000n,
  POLL_INTERVAL_MS: 4000,
  REORG_REWIND_BLOCKS: 64n,
  SHUTDOWN_TIMEOUT_MS: 20_000,
  METRICS_PORT: 0,
};

type LogLine = Record<string, unknown>;

/** A pino destination that keeps every line as parsed JSON. */
function captureLogs() {
  const lines: LogLine[] = [];
  const stream = { write: (line: string) => lines.push(JSON.parse(line) as LogLine) };
  const find = (msg: string) => lines.find((line) => line.msg === msg);
  return { lines, stream, find };
}

describe('AppModule', () => {
  it('emits constructor metadata under Vitest, so DI works without @Inject', () => {
    // If the test transformer drops `emitDecoratorMetadata`, this is undefined and Nest can't
    // resolve PinoLogger, even though the tsc build works.
    expect(Reflect.getMetadata('design:paramtypes', LifecycleService)).toEqual([
      PinoLogger,
      Object,
    ]);
  });

  // nestjs-pino keeps one root logger per module graph (its first destination wins), and Vitest
  // gives each spec file its own graph. So this file boots one application, in one test.
  it('logs JSON through nestjs-pino from boot to shutdown, with no HTTP server', async () => {
    const { lines, stream, find } = captureLogs();
    // The same options as main.ts. With abortOnError, a DI failure would abort the test worker.
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(TEST_CONFIG, stream), {
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));

    const started = find('indexer started');
    expect(started).toMatchObject({
      level: 'info',
      severity: 'INFO',
      service: 'indexer',
      version: 'test-sha',
      context: 'LifecycleService',
      chainId: 31337,
      tokenAddress: TEST_CONFIG.TOKEN_ADDRESS,
      startBlock: '9007199254740993',
    });
    expect(started?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(started).not.toHaveProperty('pid');
    expect(started).not.toHaveProperty('hostname');
    // Nest's own boot logs, buffered until useLogger, are JSON with the same fields.
    expect(
      lines.some((line) => line.context === 'InstanceLoader' && line.service === 'indexer'),
    ).toBe(true);

    const logger = await app.resolve(PinoLogger);
    // pino-http wraps the err serializer; the inner errors of a cause must survive it.
    const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:8545')], 'all failed');
    logger.error({ err: new Error('batch failed', { cause }) }, 'rpc call failed');
    expect(JSON.stringify(find('rpc call failed'))).toContain('connect ECONNREFUSED ::1:8545');

    logger.info(
      {
        config: { RPC_HTTP_URL: TEST_CONFIG.RPC_HTTP_URL, DATABASE_URL: TEST_CONFIG.DATABASE_URL },
      },
      'config dump',
    );
    expect(find('config dump')).toMatchObject({
      config: { RPC_HTTP_URL: '[REDACTED]', DATABASE_URL: '[REDACTED]' },
    });

    await app.close();
    expect(find('indexer stopped')).toMatchObject({ chainId: 31337, context: 'LifecycleService' });
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });
});
