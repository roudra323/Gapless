# `packages/db` — `@gapless/db`

Drizzle schema, committed SQL migrations, client factory, and the migrate entrypoint. Framework-free (no NestJS).

- **Built in:** Phase 2
- **Read first:** `docs/02-architecture.md` (data model)

## Usage

```ts
import { createDb, runMigrations, transfers } from '@gapless/db';

const { db, close } = createDb({
  url,
  onPoolError: (err) => logger.error({ err }, 'pg pool error'),
});
```

| Export                               | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `transfers`, `indexerCheckpoints`    | Drizzle tables (see `docs/02` "Data model")                            |
| `createDb`                           | Lazy `pg` pool + typed Drizzle instance; `close()` at shutdown         |
| `runMigrations`, `MIGRATIONS_FOLDER` | Apply the committed migrations (used by the migrate command and tests) |

## Commands

| Command            | What it does                                                                    |
| ------------------ | ------------------------------------------------------------------------------- |
| `pnpm db:generate` | Diff `src/schema.ts` against `migrations/meta` and write a new SQL migration    |
| `pnpm db:migrate`  | Build, then apply pending migrations to `DATABASE_URL` (root `.env` if present) |

## Rules

- Never edit a migration that has been applied anywhere. Change `src/schema.ts` and generate a new one.
  The migrator decides what is pending by timestamp, not by file content, so an edit is not detected.
- Migrations are additive-first (see `docs/02`).
- `migrations/` is listed in `files`, so it ships with `dist/` in the Docker image.
