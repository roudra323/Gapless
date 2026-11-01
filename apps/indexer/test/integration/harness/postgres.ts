import { createDb, type DbHandle, runMigrations } from '@gapless/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Same image as docker-compose.yml and packages/db/test/integration. Keep the three in sync.
const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

export type TestPostgres = {
  readonly url: string;
  /** A pool for the test's own queries (setup and assertions), separate from the indexer's. */
  readonly handle: DbHandle;
  readonly stop: () => Promise<void>;
};

/** Starts an empty Postgres in a container and applies the migrations. */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const url = container.getConnectionUri();
  const handle = createDb({
    url,
    // An idle connection error is a test failure: surface it as an uncaught error.
    onPoolError: (err) => {
      throw err;
    },
  });
  await runMigrations(handle.db);
  return {
    url,
    handle,
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}
