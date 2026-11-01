# `packages/config` — `@gapless/config`

Zod env schemas and `loadConfig()`. The only place that reads `process.env`. Framework-free.

- **Built in:** Phase 2 (first env read: `DATABASE_URL` for migrations); extended in each later phase
- **Read first:** `docs/02-architecture.md` (configuration), `docs/05-coding-conventions.md`

## Usage

```ts
import { dbConfigSchema, loadConfig } from '@gapless/config';

const config = loadConfig(dbConfigSchema); // reads process.env; throws ConfigError if invalid
```

| Export                | Purpose                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadConfig`          | Validates env against a Zod schema and returns the typed result.                                                                                                                                                                                               |
| `ConfigError`         | Thrown on invalid env. `issues` lists each bad key and the reason, never the value.                                                                                                                                                                            |
| `dbConfigSchema`      | `DATABASE_URL` (a `postgres://` or `postgresql://` URL). Apps extend it in later phases.                                                                                                                                                                       |
| `loggingConfigSchema` | `LOG_LEVEL` (pino level, default `info`) and `APP_VERSION` (Git SHA, default `dev`).                                                                                                                                                                           |
| `migrateConfigSchema` | `dbConfigSchema` + `loggingConfigSchema`. Used by `pnpm db:migrate`.                                                                                                                                                                                           |
| `chainConfigSchema`   | `CHAIN_ID` and `TOKEN_ADDRESS` (returned lowercase by `normalizeAddress` from `@gapless/chain`). Shared by the indexer and the API.                                                                                                                            |
| `indexerConfigSchema` | `migrateConfigSchema` + `chainConfigSchema` + `RPC_HTTP_URL`, `START_BLOCK` (>= 1), `CONFIRMATIONS`, `BATCH_SIZE`, `POLL_INTERVAL_MS`, `RPC_WS_URL` (optional; empty = unset), `REORG_REWIND_BLOCKS`, `SHUTDOWN_TIMEOUT_MS`, `METRICS_PORT` (0 = a free port). |

The entrypoint that calls `loadConfig` catches `ConfigError`, logs the invalid keys, and exits 1 (see `docs/05`).

## Rules for values

- **Whole numbers are decimal digits only.** `z.coerce` is not used: it turns an empty value into 0 and accepts `1e3` and padded values, so `CONFIRMATIONS=` would silently mean zero confirmations.
- **Block numbers and block counts are `bigint`** (`START_BLOCK`, `CONFIRMATIONS`, `BATCH_SIZE`); chain IDs and durations are `number`.
- **Addresses** are validated with viem `isAddress` (lowercase or a correct EIP-55 checksum) and returned lowercase (`docs/05` "Blockchain values"). A wrong checksum is rejected, because it is usually a typo. viem is a dependency only for this check.
- Error messages never contain the value, because values may be secrets (`DATABASE_URL`, `RPC_*`).
