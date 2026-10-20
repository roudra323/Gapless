# 06 — Testing

## Layers

| Layer | Tool | Location | Runs in | From phase |
|---|---|---|---|---|
| Unit | Vitest | `*.spec.ts` beside the code | `pnpm test`, every PR | 0 |
| Contracts | `forge test` | `contracts/test/` | every PR touching `contracts/` | 1 |
| Integration | Vitest + Testcontainers (Postgres 18, Redis 8) + anvil | `apps/*/test/integration/*.int.spec.ts` | `pnpm test:integration`, every PR | 2 (DB), 3 (indexer) |
| Chaos (indexer) | Vitest + anvil + Testcontainers | `apps/indexer/test/chaos/` | every PR (keep them fast: under 2 min total) | 4 |
| API e2e | Vitest + supertest against a booted Nest app | `apps/api/test/e2e/` | every PR | 5 |
| Manifests | `helm lint`, `helm template \| kubeconform -strict` | `deploy/` | every PR touching `deploy/` | 8 |
| Infra | `terraform fmt -check`, `terraform validate`, `tflint` | `infra/` | every PR touching `infra/` | 9 |

## What must be unit tested
- The range planner (batch boundaries, confirmations, batch-size halving and doubling).
- Reorg-guard decisions (hash match / mismatch → rewind target).
- Retry/backoff calculation.
- Cursor encode/decode, including rejecting malformed and tampered cursors.
- Address and value conversion helpers.
- Config schemas (valid, missing, malformed).

Pure logic goes in pure functions so it's unit-testable without Nest, DB, or RPC.

## Indexer integration and chaos tests (the important ones)

Shared setup: start anvil, deploy `MockToken`, start Postgres in a container, run migrations, start the indexer in-process against them.

Every test ends with the **parity assertion**: for the whole range, the set of `(tx_hash, log_index)` in the DB equals the set returned by `getLogs` from anvil. That means no gaps and no duplicates. Use the same logic as `verify.ts`.

| Test | Scenario |
|---|---|
| `baseline` | 500 transfers across many blocks → parity. |
| `kill-mid-batch` | Abort the indexer while a transaction is open, restart it → parity, and the checkpoint never ran ahead of the data. |
| `ws-drop` | Kill the WS endpoint or proxy while transfers continue → indexing continues via polling; parity. |
| `no-ws` | `RPC_WS_URL` unset → parity. |
| `rpc-flaky` | A proxy that randomly fails 30% of requests or returns 429 → parity, and the retry metrics increment. |
| `range-too-large` | The RPC rejects ranges over N blocks → the batch halves, then parity. |
| `reorg` | anvil `evm_snapshot`, emit transfers, index them, `evm_revert`, emit different transfers, mine past confirmations → old rows gone, new rows present, `reorgs_total` incremented. (Use `CONFIRMATIONS=0` for this test.) |
| `two-instances` | Start two indexers → only one acquires the lock and writes; parity; kill the leader → the other takes over; parity. |
| `graceful-shutdown` | SIGTERM during a batch → the batch commits or rolls back fully, and the process exits 0 within the timeout. |

Simulate a flaky RPC with a tiny in-test HTTP/WS proxy in front of anvil. Don't mock viem for these; the point is to exercise real behavior.

## API tests
- Pagination: walk all pages while new rows are inserted, and confirm there are no repeats or skips for rows that existed at start.
- Validation errors return problem+json with the right `errorCode` and status.
- Redis down → the API still serves (uncached) and the cache-error metric increments.
- Response formatting: decimal strings for `value`/`blockNumber`, checksummed addresses.

## Rules
- Tests are deterministic. No sleeps for synchronization: poll a condition with a timeout helper.
- No shared state between tests. Each integration suite gets its own DB (a container or a fresh schema).
- No real testnet or network calls in tests. Use anvil only.
- Coverage isn't a target number, but every invariant in `docs/03` must have a test that would fail if it broke.
