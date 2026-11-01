// Entrypoint of the indexer: `pnpm --filter @gapless/indexer start`, and the container in Phase 7.
// Exit code 0 = clean stop; 1 = invalid config or a failed boot.
import { ConfigError, type IndexerConfig, indexerConfigSchema, loadConfig } from '@gapless/config';
import { createLogger } from '@gapless/observability';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule, SERVICE_NAME } from './app.module.js';

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

  try {
    // A standalone application context: DI and lifecycle hooks, no HTTP server (Phase 4 adds
    // the health endpoints). It is initialized on return, so `onApplicationBootstrap` has run.
    // `bufferLogs` holds Nest's own boot logs until the pino logger is set. `abortOnError: false`
    // makes a boot error (for example a missing provider) throw into the catch below; Nest's
    // default calls `process.abort()`, which skips the fatal JSON log and exits with 134, not 1.
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));
    // SIGTERM/SIGINT → `app.close()` → `onApplicationShutdown` hooks (docs/03 "Graceful shutdown").
    app.enableShutdownHooks();
    return 0;
  } catch (err) {
    createLogger({
      service: SERVICE_NAME,
      version: config.APP_VERSION,
      level: config.LOG_LEVEL,
    }).fatal({ err }, 'indexer failed to start');
    return 1;
  }
}

process.exitCode = await main();
