// Entrypoint of the API: `pnpm api:start`, and the container in Phase 7.
// Exit code 0 = clean stop (SIGTERM/SIGINT); 1 = invalid config, a failed boot, or a shutdown
// that took longer than SHUTDOWN_TIMEOUT_MS.
import type { AddressInfo } from 'node:net';

import { type ApiConfig, apiConfigSchema, ConfigError, loadConfig } from '@gapless/config';
import { createLogger } from '@gapless/observability';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule, SERVICE_NAME } from './app.module.js';
import { LifecycleService } from './lifecycle.service.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

/** A logger outside Nest, for the errors that end the process. */
function fatalLogger(config: ApiConfig) {
  return createLogger({
    service: SERVICE_NAME,
    version: config.APP_VERSION,
    level: config.LOG_LEVEL,
  });
}

/**
 * If the shutdown hooks don't finish in SHUTDOWN_TIMEOUT_MS (for example, a request that never
 * ends), exit anyway with 1. The pod's terminationGracePeriodSeconds is longer, so this exit comes
 * first and is logged (the same rule as the indexer, docs/03 "Graceful shutdown").
 */
function armShutdownTimeout(config: ApiConfig): void {
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

async function main(): Promise<number> {
  let config: ApiConfig;
  try {
    config = loadConfig(apiConfigSchema);
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
    // `bufferLogs` holds Nest's own boot logs until the pino logger is set. `abortOnError: false`
    // makes a boot error throw into the catch below instead of `process.abort()` (exit 134).
    const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));
    // No `X-Powered-By: Express` header: it only tells an attacker what to try.
    app.disable('x-powered-by');
    // SIGTERM/SIGINT → readiness turns 503, the HTTP server stops and finishes open requests, then
    // the health server and the pool close. `useProcessExit` makes Nest end with exit code 0.
    app.enableShutdownHooks(SHUTDOWN_SIGNALS, { useProcessExit: true });
    armShutdownTimeout(config);

    await app.listen(config.PORT, '0.0.0.0');
    // The bound port, not config.PORT: with PORT=0 the OS picks one.
    const { port } = app.getHttpServer().address() as AddressInfo;
    app.get(LifecycleService).started(port);
    return 0;
  } catch (err) {
    fatalLogger(config).fatal({ err }, 'api failed to start');
    return 1;
  }
}

// Exit code only on failure: on success the HTTP server keeps the process alive until a signal.
const code = await main();
if (code !== 0) process.exitCode = code;
