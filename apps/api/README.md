# `apps/api` — `@gapless/api`

Read-only NestJS HTTP API (`/v1/*`) over Postgres (no cache layer). Stateless; scales 2–5 replicas.

- **Built in:** Phase 5 (API), Phase 6 (metrics)
- **Read first:** `docs/02-architecture.md` (API contract), `docs/05-coding-conventions.md`

## Status

Phase 5 in progress: `src/main.ts` (boot, shutdown hooks, listen), `src/app.module.ts` (logger with request IDs, the global problem+json filter, the feature modules), `src/shared.module.ts` (config and the database pool), package scaffold, `src/common/domain-error.ts` (`DomainError` and the `ERROR_CODE` list), `src/common/problem-details.filter.ts` (the global problem+json filter), `src/common/cursor.ts` (the keyset cursor codec), `src/common/validation.ts` (per-parameter schema validation), `src/transfers/` (request schemas, the `Transfer` type, `toTransferResponse`, the keyset repository, the service with `limit + 1` paging, the controller for `GET /v1/transfers` and `GET /v1/addresses/:address/transfers`), `src/stats/` (`GET /v1/stats` from one snapshot), `src/health/` (`/healthz` and `/readyz` on `METRICS_PORT`), `src/common/database-unavailable.ts` (a database outage becomes `503 SERVICE_UNAVAILABLE`). End-to-end tests follow.

## Usage

```bash
pnpm dev:deps      # Postgres (and anvil) in Docker
pnpm db:migrate    # create the schema
pnpm api:start     # build the API and its packages, then run it (reads ../../.env)
curl -s localhost:3000/v1/stats
curl -s localhost:9464/readyz   # health probes are on METRICS_PORT, not PORT
```

Env vars: `apiConfigSchema` in `packages/config` (`PORT` 3000, plus the shared `DATABASE_URL`, `CHAIN_ID`, `TOKEN_ADDRESS`, `METRICS_PORT`, `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`). An invalid config logs the bad keys (never the values) and exits 1.
