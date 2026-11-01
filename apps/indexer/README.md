# `apps/indexer` — `@gapless/indexer`

NestJS app that ingests ERC-20 `Transfer` logs into Postgres. The only writer of chain data. Runs as exactly one active instance (advisory lock).

- **Built in:** Phase 3 (core), Phase 4 (resilience), Phase 6 (metrics)
- **Read first:** `docs/03-indexer-design.md` (mandatory), `docs/06-testing.md`

## Run

```bash
pnpm indexer:start   # from the repo root: builds the indexer and its packages, then runs dist/main.js
```

It reads the root `.env` (see `docs/02` "Configuration"). `TOKEN_ADDRESS` must be a deployed contract, so deploy `MockToken` first (`contracts/README.md`). To read the logs locally: `pnpm --silent indexer:start | pnpm exec pino-pretty`.

The app always runs from the `tsc` build. `tsx` and Node's type stripping drop decorator metadata, which NestJS DI needs (`docs/04`).

## Structure

| File                       | Purpose                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`              | Parses the env, boots a standalone Nest application context (no HTTP server yet), and exits 1 with a `fatal` log on bad config or boot. |
| `src/app.module.ts`        | `AppModule.forRoot(config)`: nestjs-pino with the shared logger options, the config provider, and the lifecycle service.                |
| `src/config.provider.ts`   | The `INDEXER_CONFIG` DI token for the validated config.                                                                                 |
| `src/lifecycle.service.ts` | Logs `indexer started` and `indexer stopped`. The ingestion loop starts here (Phase 3 step 8).                                          |

Current state: the app boots, logs, and exits 0, because there is no ingestion loop yet.
