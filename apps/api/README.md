# `apps/api` — `@gapless/api`

Read-only NestJS HTTP API (`/v1/*`) over Postgres (no cache layer). Stateless; scales 2–5 replicas.

- **Built in:** Phase 5 (API), Phase 6 (metrics)
- **Read first:** `docs/02-architecture.md` (API contract), `docs/05-coding-conventions.md`

## Status

Phase 5 in progress: package scaffold, `src/common/domain-error.ts` (`DomainError` and the `ERROR_CODE` list), `src/common/problem-details.filter.ts` (the global problem+json filter). The endpoints and `main.ts` follow.
