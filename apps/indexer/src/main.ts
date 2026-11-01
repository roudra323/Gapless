// Entrypoint of the indexer: `pnpm --filter @gapless/indexer start`, and the container in Phase 7.
// Exit code 0 = clean stop (SIGTERM/SIGINT); 1 = invalid config, a failed boot, a fatal indexing
// error, or a shutdown that took longer than SHUTDOWN_TIMEOUT_MS.
import { redactRpcUrl } from '@gapless/chain';
import { ConfigError, type IndexerConfig, indexerConfigSchema, loadConfig } from '@gapless/config';
import { createLogger } from '@gapless/observability';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule, SERVICE_NAME } from './app.module.js';
import { IngestionService } from './ingestion/ingestion.service.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

/**
 * If the shutdown hooks don't finish in SHUTDOWN_TIMEOUT_MS, exit anyway (docs/03 "Graceful
 * shutdown"). An open transaction then rolls back, so the checkpoint stays consistent.
 */
function armShutdownTimeout(config: IndexerConfig): void {
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    // unref: the timer alone must not keep the process alive after a clean shutdown.
    setTimeout(() => {
      fatalLogger(config).fatal(
        { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        'shutdown timed out, exiting',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS).unref();
  };
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, arm);
}

/** A logger outside Nest, for the errors that end the process. */
function fatalLogger(config: IndexerConfig) {
  return createLogger({
    service: SERVICE_NAME,
    version: config.APP_VERSION,
    level: config.LOG_LEVEL,
  });
}

async function main(): Promise<number> {
  let config: IndexerConfig;
  try {
    config = loadConfig(indexerConfigSchema);
  } catch (err) {
    if (err instanceof ConfigError) {
      // LOG_LEVEL and APP_VERSION may be the invalid keys, so log with fixed values.
      // ConfigError holds keys and reasons only, never the values.
      createLogger({ service: SERVICE_NAME, version: 'unknown', level: 'info' }).fatal(
        { issues: err.issues },
        'invalid configuration',
      );
      return 1;
    }
    throw err;
  }

  let app: INestApplicationContext;
  try {
    // A standalone application context: DI and lifecycle hooks, no Nest HTTP server (the health
    // endpoints are a small node:http server, see health/). It is initialized on return, so
    // `onApplicationBootstrap` has run and the health server listens.
    // `bufferLogs` holds Nest's own boot logs until the pino logger is set. `abortOnError: false`
    // makes a boot error (for example a missing provider) throw into the catch below; Nest's
    // default calls `process.abort()`, which skips the fatal JSON log and exits with 134, not 1.
    app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));
    // SIGTERM/SIGINT → the shutdown hooks: the loop stops between steps (an open transaction
    // finishes), the lock is released, the socket and the pool close. `useProcessExit` makes Nest
    // end with exit code 0; without it Nest re-raises the signal and the exit code is 143.
    app.enableShutdownHooks(SHUTDOWN_SIGNALS, { useProcessExit: true });
    armShutdownTimeout(config);
  } catch (err) {
    fatalLogger(config).fatal({ err }, 'indexer failed to start');
    return 1;
  }

  try {
    await app.get(IngestionService).run();
    return 0;
  } catch (err) {
    // viem errors carry the RPC URL, which may hold an API key.
    fatalLogger(config).fatal(
      { err: redactRpcUrl(err, config.RPC_HTTP_URL) },
      'indexer stopped on a fatal error',
    );
    await app.close();
    return 1;
  }
}

process.exitCode = await main();
