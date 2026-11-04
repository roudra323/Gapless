# `apps/api` — `@gapless/api`

Read-only NestJS HTTP API (`/v1/*`) over Postgres (no cache layer). Stateless; scales 2–5 replicas.

- **Built in:** Phase 5 (API), Phase 6 (metrics)
- **Read first:** `docs/02-architecture.md` (API contract), `docs/05-coding-conventions.md`

## Status

Phase 5 in progress: package scaffold, `src/common/domain-error.ts` (`DomainError` and the `ERROR_CODE` list), `src/common/problem-details.filter.ts` (the global problem+json filter), `src/common/cursor.ts` (the keyset cursor codec), `src/common/validation.ts` (per-parameter schema validation), `src/transfers/` (request schemas, the `Transfer` type, `toTransferResponse`, the keyset repository, the service with `limit + 1` paging, the controller for `GET /v1/transfers` and `GET /v1/addresses/:address/transfers`), `src/stats/` (`GET /v1/stats` from one snapshot), `src/common/database-unavailable.ts` (a database outage becomes `503 SERVICE_UNAVAILABLE`). The endpoints and `main.ts` follow.
