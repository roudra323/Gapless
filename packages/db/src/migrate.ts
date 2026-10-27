import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './client.js';

/**
 * Absolute path of the committed SQL migrations. Resolved from this file, so it is the
 * same from `src/` (tests) and from `dist/` (the built package and the Docker image).
 */
export const MIGRATIONS_FOLDER = path.join(import.meta.dirname, '..', 'migrations');

/**
 * Applies every migration in {@link MIGRATIONS_FOLDER} that the database has not seen yet.
 * Pending migrations run in one transaction: either all apply, or none do.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
