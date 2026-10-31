// Entrypoint for `pnpm db:migrate` and the Kubernetes migrate Job (Phase 8).
// Exit code 0 = schema is up to date; 1 = config or migration failure.
import { ConfigError, loadConfig, migrateConfigSchema } from '@gapless/config';
import { createLogger } from '@gapless/observability';

import { createDb } from '../client.js';
import { runMigrations } from '../migrate.js';

const SERVICE = 'migrate';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(migrateConfigSchema);
  } catch (err) {
    if (err instanceof ConfigError) {
      // LOG_LEVEL and APP_VERSION may be the invalid keys, so log with fixed values.
      // ConfigError holds keys and reasons only, never the values.
      createLogger({ service: SERVICE, version: 'unknown', level: 'info' }).fatal(
        { issues: err.issues },
        'invalid configuration',
      );
      return 1;
    }
    throw err;
  }

  const logger = createLogger({
    service: SERVICE,
    version: config.APP_VERSION,
    level: config.LOG_LEVEL,
  });
  const { db, close } = createDb({
    url: config.DATABASE_URL,
    applicationName: 'gapless-migrate',
    maxConnections: 1,
    onPoolError: (err) => logger.error({ err }, 'idle connection error'),
  });
  try {
    await runMigrations(db);
    logger.info('migrations applied');
    return 0;
  } catch (err) {
    logger.fatal({ err }, 'migrate failed');
    return 1;
  } finally {
    await close();
  }
}

process.exitCode = await main();
