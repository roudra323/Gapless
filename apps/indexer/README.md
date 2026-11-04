# `apps/indexer` — `@gapless/indexer`

NestJS app that ingests ERC-20 `Transfer` logs into Postgres. The only writer of chain data. Runs as exactly one active instance (advisory lock).

- **Built in:** Phase 3 (core), Phase 4 (resilience), Phase 6 (metrics)
- **Read first:** `docs/03-indexer-design.md` (mandatory), `docs/06-testing.md`

## Run

```bash
pnpm indexer:start   # from the repo root: builds the indexer and its packages, then runs dist/main.js
pnpm verify          # compares the DB with eth_getLogs for START_BLOCK..checkpoint (gaps, duplicates)
pnpm verify --from 100 --to 200 --chunk 500
```

Both read the root `.env` (see `docs/02` "Configuration"). `TOKEN_ADDRESS` must be a deployed contract, so deploy `MockToken` first (`contracts/README.md`), and run `pnpm db:migrate` once. To read the logs locally: `pnpm --silent indexer:start | pnpm exec pino-pretty`.

`verify` exit codes: 0 = parity, 2 = mismatch (the JSON line lists up to 20 keys of each kind), 1 = invalid input or a failed RPC or DB call.

The app always runs from the `tsc` build. `tsx` and Node's type stripping drop decorator metadata, which NestJS DI needs (`docs/04`).

Exit codes of the indexer: 0 = clean stop on SIGTERM or SIGINT (the open batch commits first); 1 = invalid config, a failed boot, a fatal indexing error, or a shutdown longer than `SHUTDOWN_TIMEOUT_MS`.

Health, on `METRICS_PORT` (9464, never public): `GET /healthz` is 200 while the loop's heartbeat is fresh; `GET /readyz` is 200 only on the leader with a reachable DB. A standby is live but not ready.

## Structure

| File                                  | Purpose                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                         | Parses the env, boots a standalone Nest application context, runs the indexer, owns the exit codes and the shutdown timeout. |
| `src/app.module.ts`                   | `AppModule.forRoot(config)`: nestjs-pino, the shared providers, health, ingestion, and the lifecycle log lines.              |
| `src/shared.module.ts`                | Global providers: the config, the viem client, the Postgres pool, the heartbeat, the leader status.                          |
| `src/config.provider.ts`              | The `INDEXER_CONFIG` DI token for the validated config.                                                                      |
| `src/lifecycle.service.ts`            | Logs `indexer started` and `indexer stopped`.                                                                                |
| `src/verify.ts`                       | The `pnpm verify` entrypoint.                                                                                                |
| `src/verify/verify-range.ts`          | The parity check, shared with the tests.                                                                                     |
| `src/head/head-tracker.ts`            | The latest head: an HTTP poll that always runs, plus the optional WebSocket doorbell with its own reconnect.                 |
| `src/leader/leader-lock.ts`           | `pg_try_advisory_lock` on one dedicated connection; the session's Drizzle instance carries every write.                      |
| `src/leader/lock-key.ts`              | The 64-bit lock key for a chain and token.                                                                                   |
| `src/leader/leader-status.ts`         | Whether this process leads now (read by `/readyz`).                                                                          |
| `src/health/health-status.ts`         | The liveness window and the readiness rule.                                                                                  |
| `src/health/heartbeat.ts`             | The heartbeat the loop and the supervisor beat.                                                                              |
| `src/health/health.service.ts`        | Starts and stops the health server (`HealthServer` from `@gapless/observability`) with the app.                              |
| `src/ingestion/ingestion.service.ts`  | Builds the head tracker, the lock, the supervisor and the loop, and stops them on shutdown.                                  |
| `src/ingestion/indexer-supervisor.ts` | Runs one loop per leadership term; waits as a standby; gives up the lock when its connection fails.                          |
| `src/ingestion/ingestion-loop.ts`     | One term of ingestion: startup checks, planning, fetch, commit, backoff, reorg rewind.                                       |
| `src/ingestion/range-planner.ts`      | `planNextRange`: the next confirmed range after the checkpoint.                                                              |
| `src/ingestion/batch-size.ts`         | Halve on a rejected range, double after 10 successes.                                                                        |
| `src/ingestion/backoff.ts`            | Exponential backoff with full jitter (500 ms base, 30 s cap).                                                                |
| `src/ingestion/reorg.ts`              | `findRewindTarget`: the proven rewind target.                                                                                |
| `src/ingestion/batch-fetcher.ts`      | One JSON-RPC batch (anchor, `to` header, `eth_getLogs`), then the log-block headers.                                         |
| `src/ingestion/range-consistency.ts`  | The consistency checks and the log-to-row mapping.                                                                           |
| `src/ingestion/indexer.repository.ts` | Checkpoint seed and read, the atomic fenced batch commit, and the atomic fenced rewind.                                      |
| `src/ingestion/ingestion-errors.ts`   | The error classes, each marked retryable or not.                                                                             |

## Error policy

| Error                                                               | Reaction                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Range rejected by the RPC (timeout, 413, "too many results")        | Halve the batch, retry the same range at once.                   |
| Anchor mismatch (a reorg)                                           | `warn`, the proven rewind, continue.                             |
| Anything else that is not fatal (network, 429, 5xx, a check failed) | `warn`, read the checkpoint again, retry after backoff, forever. |
| The lock connection fails                                           | Stop the loop, release, wait as a standby, take the lock again.  |
| Invalid Transfer log, fence miss, token has no code                 | `fatal`, exit 1.                                                 |

Tests: unit specs beside the code; `test/integration/` (repository, lock, WebSocket, baseline parity); `test/chaos/` (`pnpm test:chaos`, the scenarios of `docs/06`).
