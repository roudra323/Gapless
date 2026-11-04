# `apps/api` — `@gapless/api`

Read-only NestJS HTTP API (`/v1/*`) over Postgres (no cache layer). Stateless; scales 2–5 replicas.

- **Built in:** Phase 5 (API), Phase 6 (metrics)
- **Read first:** `docs/02-architecture.md` (API contract), `docs/05-coding-conventions.md`

## Status

Phase 5 done: `GET /v1/transfers`, `GET /v1/addresses/:address/transfers`, `GET /v1/stats`, `/healthz` and `/readyz` on `METRICS_PORT`, RFC 9457 problem+json errors, and JSON request logs with `reqId`. Metrics come in Phase 6.

## Layout

| Path                   | What                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `src/main.ts`          | Boot: config, logger, shutdown hooks and timeout, listen                                      |
| `src/app.module.ts`    | Root module: logger with request IDs, the global problem+json filter, the feature modules     |
| `src/shared.module.ts` | Global config and the database pool (`src/database/`), closed on shutdown                     |
| `src/common/`          | `DomainError`, the problem+json filter, the cursor codec, `validated()`, DB outage → 503      |
| `src/transfers/`       | Request schemas, keyset repository, service (`limit + 1` paging), controller, response mapper |
| `src/stats/`           | One read-only snapshot for the count and the checkpoint                                       |
| `src/health/`          | Liveness and readiness (`select 1` within 2 s, 503 once shutdown starts)                      |
| `test/integration/`    | Repositories against Postgres, with `EXPLAIN` checks                                          |
| `test/e2e/`            | The whole app against Postgres (run by `pnpm test:integration`)                               |

## Usage

```bash
pnpm dev:deps      # Postgres (and anvil) in Docker
pnpm db:migrate    # create the schema
pnpm api:start     # build the API and its packages, then run it (reads ../../.env)
curl -s localhost:3000/v1/stats
curl -s localhost:9464/readyz   # health probes are on METRICS_PORT, not PORT
```

Env vars: `apiConfigSchema` in `packages/config` (`PORT` 3000, plus the shared `DATABASE_URL`, `CHAIN_ID`, `TOKEN_ADDRESS`, `METRICS_PORT`, `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`). An invalid config logs the bad keys (never the values) and exits 1.
