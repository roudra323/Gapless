# `packages/config` — `@gapless/config`

Zod env schemas and `loadConfig()`. The only place that reads `process.env`. Framework-free.

- **Built in:** Phase 2 (first env read: `DATABASE_URL` for migrations); extended in each later phase
- **Read first:** `docs/02-architecture.md` (configuration), `docs/05-coding-conventions.md`

## Usage

```ts
import { dbConfigSchema, loadConfig } from '@gapless/config';

const config = loadConfig(dbConfigSchema); // reads process.env; throws ConfigError if invalid
```

| Export           | Purpose                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `loadConfig`     | Validates env against a Zod schema and returns the typed result.                         |
| `ConfigError`    | Thrown on invalid env. `issues` lists each bad key and the reason, never the value.      |
| `dbConfigSchema` | `DATABASE_URL` (a `postgres://` or `postgresql://` URL). Apps extend it in later phases. |

The entrypoint that calls `loadConfig` catches `ConfigError`, prints the invalid keys, and exits 1 (see `docs/05`).
