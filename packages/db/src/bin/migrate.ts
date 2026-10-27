// Entrypoint for `pnpm db:migrate` and the Kubernetes migrate Job (Phase 8).
// Exit code 0 = schema is up to date; 1 = config or migration failure.
import { ConfigError, dbConfigSchema, loadConfig } from '@gapless/config';

import { createDb } from '../client.js';
import { runMigrations } from '../migrate.js';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(dbConfigSchema);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Keys and reasons only; ConfigError never holds the values.
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const { db, close } = createDb({
    url: config.DATABASE_URL,
    applicationName: 'gapless-migrate',
    maxConnections: 1,
    onPoolError: (err) => process.stderr.write(`idle connection error: ${err.message}\n`),
  });
  try {
    await runMigrations(db);
    process.stdout.write('migrations applied\n');
    return 0;
  } finally {
    await close();
  }
}

/** The message of an error and of each `cause` under it. Drizzle wraps driver errors, so the root cause is the last line. */
function describeError(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    // Connecting to `localhost` tries IPv4 and IPv6 and throws an AggregateError with an
    // empty message; the details are in `errors`.
    lines.push(
      current instanceof AggregateError
        ? current.errors
            .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
            .join('; ')
        : current.message,
    );
    current = current.cause;
  }
  if (current !== undefined) lines.push(String(current));
  return lines.join('\n  caused by: ');
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`migrate failed: ${describeError(err)}\n`);
  process.exitCode = 1;
}
