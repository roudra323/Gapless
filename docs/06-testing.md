# 06 — Testing

## Layers

| Layer           | Tool                                                   | Location                                           | Runs in                                                         | From phase          |
| --------------- | ------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------- | ------------------- |
| Unit            | Vitest                                                 | `*.spec.ts` beside the code                        | `pnpm test`, every PR                                           | 0                   |
| Contracts       | `forge test`                                           | `contracts/test/`                                  | every PR touching `contracts/`                                  | 1                   |
| Integration     | Vitest + Testcontainers (Postgres 18) + anvil          | `{apps,packages}/*/test/integration/*.int.spec.ts` | `pnpm test:integration`, every PR                               | 2 (DB), 3 (indexer) |
| Chaos (indexer) | Vitest + anvil + Testcontainers                        | `apps/indexer/test/chaos/*.chaos.spec.ts`          | `pnpm test:chaos`, every PR (keep them fast: under 2 min total) | 4                   |
| API e2e         | Vitest + supertest against a booted Nest app           | `apps/api/test/e2e/*.e2e.spec.ts`                  | `pnpm test:integration`, every PR                               | 5                   |
| Manifests       | `helm lint`, `helm template \| kubeconform -strict`    | `deploy/`                                          | every PR touching `deploy/`                                     | 8                   |
| Infra           | `terraform fmt -check`, `terraform validate`, `tflint` | `infra/`                                           | every PR touching `infra/`                                      | 9                   |
| Infra (Floci)   | `terraform apply` + `destroy` against Floci            | `infra/terraform/envs/dev`                         | `make floci-apply`, every PR touching `infra/`                  | 9a                  |
| Load (demo)     | k6                                                     | `deploy/load/`                                     | `make load`, by hand against kind or EKS (not in CI)            | 8                   |

## What must be unit tested

- The range planner (batch boundaries, confirmations, batch-size halving and doubling).
- Reorg-guard decisions (hash match / mismatch → rewind target).
- Retry/backoff calculation.
- Cursor encode/decode, including rejecting malformed and tampered cursors.
- Address and value conversion helpers.
- Config schemas (valid, missing, malformed).

Pure logic goes in pure functions so it's unit-testable without Nest, DB, or RPC.

## Indexer integration and chaos tests (the important ones)

Shared setup: start anvil in a container (Testcontainers, the same pinned image as `docker-compose.yml`), deploy `MockToken` with viem from the `forge build` artifact (`contracts/out/MockToken.sol/MockToken.json`), start Postgres in a container, run migrations, start the indexer in-process against them. The test sends its transfers with viem too, so it controls how they spread across blocks and can send more while the indexer runs. The helpers live in `apps/indexer/test/integration/harness/`, and the parity check is `verifyRange` (`src/verify/verify-range.ts`). `contracts/out/` is git-ignored, so run `forge build` in `contracts/` before `pnpm test:integration` (CI does).

Every test ends with the **parity assertion**: for the whole range, the set of `(tx_hash, log_index)` in the DB equals the set returned by `getLogs` from anvil. That means no gaps and no duplicates. Use the same logic as `verify.ts`.

| Test                | Scenario                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`          | 500 transfers across many blocks → parity.                                                                                                                                                                                                |
| `kill-mid-batch`    | Abort the indexer while a transaction is open, restart it → parity, and the checkpoint never ran ahead of the data.                                                                                                                       |
| `ws-drop`           | Kill the WS endpoint or proxy while transfers continue → indexing continues via polling; parity.                                                                                                                                          |
| `no-ws`             | `RPC_WS_URL` unset → parity.                                                                                                                                                                                                              |
| `rpc-flaky`         | A proxy that randomly fails 30% of requests or returns 429 → parity, and the retry metrics increment.                                                                                                                                     |
| `rpc-lagging-node`  | A proxy that answers `getLogs` with `[]` and `getBlockByNumber(to)` with `null` for blocks above a lagging height, as a node behind a load balancer does → no checkpoint moves past the lagging height until the node catches up; parity. |
| `range-too-large`   | The RPC rejects ranges over N blocks → the batch halves, then parity.                                                                                                                                                                     |
| `reorg`             | anvil `evm_snapshot`, emit transfers, index them, `evm_revert`, emit different transfers, mine past confirmations → old rows gone, new rows present, `reorgs_total` incremented. (Use `CONFIRMATIONS=0` for this test.)                   |
| `reorg-deep`        | Like `reorg`, but the revert goes deeper than `REORG_REWIND_BLOCKS` (set it small, for example 2) and the new fork has transfers in blocks below `last_block - REORG_REWIND_BLOCKS` → the rewind goes back to a proven block; parity.     |
| `two-instances`     | Start two indexers → only one acquires the lock and writes; parity; kill the leader → the other takes over; parity.                                                                                                                       |
| `graceful-shutdown` | SIGTERM during a batch → the batch commits or rolls back fully, and the process exits 0 within the timeout.                                                                                                                               |

Simulate a flaky RPC with a tiny in-test HTTP/WS proxy in front of anvil. Don't mock viem for these; the point is to exercise real behavior.

How the chaos tests are built (`apps/indexer/test/chaos/*.chaos.spec.ts`, run with `pnpm test:chaos`, which builds the indexer first):

- **Proxies:** `harness/rpc-proxy.ts` (JSON-RPC over HTTP, single and batch: fail a request with 429, 500 or a reset, or answer one call itself) and `harness/tcp-proxy.ts` (a plain TCP pipe for the WebSocket: drop every connection, refuse new ones).
- **Real signals:** `kill-mid-batch` and `graceful-shutdown` run `dist/main.js` as a child process (`harness/indexer-process.ts`), so SIGKILL and SIGTERM and the exit code are real.
- **Mid-transaction without timing guesses:** `harness/row-hold.ts` locks the checkpoint row (`SELECT … FOR UPDATE`). The indexer's batch then inserts its rows and blocks on the checkpoint UPDATE in its open transaction (visible in `pg_stat_activity`), and the test acts at exactly that point.
- **Metrics come in Phase 6.** Until then, where a scenario above says a metric increments (`rpc-flaky`, `reorg`), the test checks the matching `warn` log line instead (`indexing step failed, retrying after backoff`, `reorg detected, rewinding`). Add the metric assertions in Phase 6.
- One file per scenario group, each with its own containers. The whole suite (15 tests) runs in about 30–65 s locally.

## API tests

- Pagination: walk all pages while new rows are inserted, and confirm there are no repeats or skips for rows that existed at start.
- Validation errors return problem+json with the right `errorCode` and status.
- DB down → `/readyz` returns 503 and requests fail with a problem+json 503, not a stack trace.
- Response formatting: decimal strings for `value`/`blockNumber`, checksummed addresses.

How they are built:

- **Unit** (`apps/api/src/**/*.spec.ts`): pure logic (cursor, schemas, mappers, the filter) and the services with a fake repository. `src/app.module.spec.ts` boots the whole app against a refused `DATABASE_URL` to check the wiring: logs, `reqId`, 503 problem+json, the health server, shutdown.
- **Integration** (`apps/api/test/integration/`): the repositories against Postgres 18, including `EXPLAIN` checks that every request query uses an index and sorts nothing.
- **E2E** (`apps/api/test/e2e/`): `harness/api.ts` boots `AppModule` in-process on free ports against a Postgres container (the integration harness), and supertest calls it. They run in `pnpm test:integration`, because they need Docker. nestjs-pino keeps one root logger per test file (module state), so each file boots one app.
  - `transfers.e2e.spec.ts`: page walks (`/v1/transfers` and each `direction`) while a new block is inserted between pages; a walk returns exactly the rows that existed when it started, in order. Also the response format (a block above `Number.MAX_SAFE_INTEGER`, `2^256 - 1`) and every `errorCode`.
  - `stats.e2e.spec.ts`: before and after a checkpoint exists.
  - `database-down.e2e.spec.ts`: stops the container under the running app.

## Rules

- Tests are deterministic. No sleeps for synchronization: poll a condition with a timeout helper.
- No shared state between tests. Each integration suite gets its own DB (a container or a fresh schema).
- No real testnet or network calls in tests. Use anvil only.
- Vitest caches transformed modules (`node_modules/.vitest-cache`), and a tsconfig change doesn't invalidate the cache. After changing a tsconfig (for example the decorator options), run `pnpm exec vitest --clearCache` before trusting the result.
- Tests import workspace packages from `src/`, not `dist/`: both Vitest configs set the `@gapless/source` export condition (`SOURCE_CONDITIONS` in `vitest.config.ts`). Without it, a test of an app runs against the last build of a package.
- Coverage isn't a target number, but every invariant in `docs/03` must have a test that would fail if it broke.
