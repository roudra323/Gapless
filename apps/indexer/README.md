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

## Structure

| File                                  | Purpose                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                         | Parses the env, boots a standalone Nest application context (no HTTP server yet), runs the loop, and exits 1 with a `fatal` log on failure. |
| `src/app.module.ts`                   | `AppModule.forRoot(config)`: nestjs-pino with the shared logger options, the lifecycle service, and the ingestion module.                   |
| `src/config.provider.ts`              | The `INDEXER_CONFIG` DI token for the validated config.                                                                                     |
| `src/lifecycle.service.ts`            | Logs `indexer started` and `indexer stopped`.                                                                                               |
| `src/verify.ts`                       | The `pnpm verify` entrypoint.                                                                                                               |
| `src/verify/verify-range.ts`          | The parity check, shared with the integration tests.                                                                                        |
| `src/ingestion/ingestion.module.ts`   | Wires the viem client, the Postgres pool and `IngestionService`.                                                                            |
| `src/ingestion/ingestion.service.ts`  | Builds the loop over viem and the repository, and stops it on shutdown.                                                                     |
| `src/ingestion/ingestion-loop.ts`     | The polling loop: startup checks, range planning, fetch, commit, and the error policy.                                                      |
| `src/ingestion/range-planner.ts`      | `planNextRange`: the next confirmed range after the checkpoint.                                                                             |
| `src/ingestion/batch-size.ts`         | Halve on a rejected range, double after 10 successes.                                                                                       |
| `src/ingestion/batch-fetcher.ts`      | One JSON-RPC batch (anchor, `to` header, `eth_getLogs`), then the log-block headers.                                                        |
| `src/ingestion/range-consistency.ts`  | The consistency checks and the log-to-row mapping.                                                                                          |
| `src/ingestion/indexer.repository.ts` | Checkpoint seed and read, and the atomic, fenced batch commit.                                                                              |
| `src/ingestion/ingestion-errors.ts`   | The error classes, each marked retryable or not.                                                                                            |

## Error policy (Phase 3)

| Error                                                                | Reaction                                            |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| Range rejected by the RPC (timeout, 413, "too many results")         | Halve the batch, retry the same range at once.      |
| Anything else that is not fatal (network, 429, 5xx, a check failed)  | `warn`, read the checkpoint again, retry next poll. |
| Invalid Transfer log, anchor mismatch, fence miss, token has no code | `fatal`, exit 1.                                    |

Phase 4 replaces the next-poll retry with backoff and jitter, and the anchor-mismatch stop with the reorg rewind.

Current state: the indexer polls over HTTP and indexes until it is stopped. On SIGTERM it stops between steps; the exit code 0 and the shutdown timeout arrive in Phase 4.
