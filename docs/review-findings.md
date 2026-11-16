# Review findings

An independent review of Phases 0–8 (branch `feat/local-k8s`, commit `9d9c0ef`, 2026-11-17). Six reviewers each covered one area: the indexer, the API, the shared packages, the tests, Kubernetes and observability, and CI and docs. A second reviewer then checked every weakness against the code and tried to refute it. Findings that were refuted, or that are documented design choices that need no action, are left out. The severities below are the ones after that check.

**Plan:** fix these in Phase 10 (Polish). The items in [Phase 9 notes](#phase-9-notes) are about the AWS build, so handle them while Phase 9 is built, not later. Line numbers refer to commit `9d9c0ef` and will drift; search for the code if a line does not match.

**Verdict:** no high-severity bug. Every indexer invariant in `docs/03` holds on the main path, and the chaos suite tests the failure modes a reviewer would ask about. The gaps are at the edges: timeouts, shutdown draining, a few untested paths, and CI scanning.

Severity: **medium** = a meaningful design, operations, or test gap; **low** = hardening or polish.

## Summary

| ID    | Severity | Finding                                                                        |
| ----- | -------- | ------------------------------------------------------------------------------ |
| DB-1  | medium   | No Postgres timeouts anywhere (connect, statement, idle-in-tx)                 |
| API-1 | medium   | API shutdown has no drain delay before the HTTP server closes                  |
| IDX-1 | medium   | The indexer never checks the RPC's `eth_chainId` against `CHAIN_ID`            |
| TST-1 | medium   | No indexer chaos test for a full Postgres outage                               |
| CI-1  | medium   | Renovate cannot see many pinned versions, but `docs/08` says it does           |
| CI-2  | medium   | No security scanning in CI                                                     |
| IDX-2 | low      | A failed rewind is treated as a rejected range                                 |
| IDX-3 | low      | Any RPC timeout halves the batch with no backoff                               |
| IDX-4 | low      | `findRewindTarget` has no clamp; START_BLOCK is not checked on start           |
| IDX-5 | low      | Shutdown and the heartbeat do not reach inside `fetchRange`                    |
| IDX-6 | low      | The indexer readiness check can fill the pool when the DB hangs                |
| IDX-7 | low      | One `0x` answer from `eth_getCode` is fatal                                    |
| IDX-8 | low      | Small indexer polish items                                                     |
| API-2 | low      | Readiness shares the request pool; pool exhaustion reads as an outage          |
| API-3 | low      | Behind the Gateway, a DB outage gives Envoy's 503, not problem+json            |
| API-4 | low      | Node's HTTP keep-alive timeout is shorter than Envoy's                         |
| API-5 | low      | No rate limiting and no `Cache-Control`                                        |
| API-6 | low      | `/v1/stats` runs `count(*)` on every request with no cache                     |
| DB-2  | low      | No CI check for drift between `schema.ts` and the migrations                   |
| DB-3  | low      | Migration safety for the pre-upgrade hook is not documented                    |
| DB-4  | low      | Numeric columns accept negative values                                         |
| DB-5  | low      | Secondary indexes leave out `token_address`                                    |
| DB-6  | low      | The `text` versus `bytea` choice is not recorded                               |
| TST-2 | low      | The multi-chunk header fetch in `batch-fetcher` is never run                   |
| TST-3 | low      | The split-node RPC trade-off is not tested, and `docs/03` says it is           |
| TST-4 | low      | Only the kill tests check `rowsAboveCheckpoint`                                |
| TST-5 | low      | The parity oracle's chunk loop is untested                                     |
| TST-6 | low      | Tests inside a file depend on each other                                       |
| TST-7 | low      | Fixed sleeps and wall-clock assertions remain                                  |
| TST-8 | low      | The end-to-end confirmations check is race-prone                               |
| TST-9 | low      | Duplicated test helpers                                                        |
| K8S-1 | low      | `IndexerStalled` fires for a standby process                                   |
| K8S-2 | low      | Alert rules hard-code the namespace; `IndexerLagHigh` counts confirmations     |
| K8S-3 | low      | `IndexerNoLeader` drops the namespace; `ApiHighErrorRate` has no traffic floor |
| K8S-4 | low      | The migrate Job has no time bound                                              |
| K8S-5 | low      | The grace-period rule is kept by comments only                                 |
| K8S-6 | low      | `chart-lint` renders only one values combination                               |
| CI-3  | low      | The README status line is stale                                                |
| CI-4  | low      | CI does not enforce commitlint or fail on lint warnings                        |
| CI-5  | low      | Small doc and code inconsistencies                                             |
| CI-6  | low      | Copy-pasted CI setup and no Foundry cache                                      |
| CI-7  | low      | Agent files are visible or not ignored                                         |

## Medium

### DB-1: No Postgres timeouts anywhere

- [ ] Fixed

**Problem.** `createDb` sets `connectionTimeoutMillis: options.connectionTimeoutMillis ?? 0` (wait forever) and `keepAlive: true` with the OS default initial delay (about 2 h on Linux). The indexer and the migrate Job pass no timeout. Nothing sets `statement_timeout`, `idle_in_transaction_session_timeout`, or `lock_timeout`.

Effects:

- A half-open lock connection (network split, not a clean kill) makes the leader's commit or `pg_advisory_unlock` hang until the liveness probe kills the Pod.
- While the DB is unreachable, a standby's `pool.connect()` in `leader-lock.ts:40` can hang past the 60 s liveness window, so standbys restart again and again.
- In the API, a slow query can hold one of the 10 pool connections with no limit. Liveness is always true, so a Pod whose pool is held stays unready and is never restarted.
- The chaos test `two-instances.chaos.spec.ts:90-92` says it simulates "a network split or a DB failover", but `pg_terminate_backend` is a clean server-side kill.

**Evidence.** `packages/db/src/client.ts:45-53`; `apps/indexer/src/ingestion/ingestion.providers.ts:32-38`; `apps/api/src/database/database.providers.ts:31` (the API sets only a 2 s connect timeout); a repo-wide search for `statement_timeout`, `idle_in_transaction`, `lock_timeout`, `tcp_keepalives` finds nothing.

**Fix.** Give the indexer pool a connect timeout. Set `statement_timeout` and `idle_in_transaction_session_timeout` in the pool config (node-postgres supports both as client options); keep the indexer's statement timeout generous enough for a full batch insert. Set `keepAliveInitialDelayMillis` to a short value. Fix the chaos-test comment, or add a black-hole test (a TCP proxy that stops forwarding). See also K8S-4 and [Phase 9 notes](#phase-9-notes) (server-side keepalives).

### API-1: API shutdown has no drain delay

- [ ] Fixed

**Problem.** `beforeApplicationShutdown` only sets `shuttingDown = true`. Nest then closes the HTTP server at once (`NestApplicationContext.close` runs the hooks and `dispose()` back to back). Endpoint removal on Pod deletion does not wait for the readiness probe, so Envoy and kube-proxy can still send new connections after the server stops accepting them. Every rollout and HPA scale-down can produce short bursts of 503s or connection resets. The comment at `health.service.ts:61-64` says Kubernetes "stops sending new requests to this pod while the open ones finish", which the code does not do.

**Evidence.** `apps/api/src/health/health.service.ts:61-67`; `apps/api/src/main.ts:75-77`; `deploy/helm/gapless/templates/api-deployment.yaml` has no `lifecycle` block. The k6 script ramps down long before the HPA's 5-minute scale-down window, so no test covers termination under load. No test holds a request open during SIGTERM (only `health.service.spec.ts:68` checks the flag).

**Fix.** Add a native `lifecycle.preStop.sleep` of about 5–10 s (the image is distroless, so an exec `sleep` cannot run), or an in-app delay between the readiness flip and `app.close()`. Keep `terminationGracePeriodSeconds` above delay + `SHUTDOWN_TIMEOUT_MS`. Correct the comment. Add a test that starts a slow request, sends SIGTERM, and asserts the request completes.

### IDX-1: The indexer never checks `eth_chainId`

- [ ] Fixed

**Problem.** The only startup guard is the `eth_getCode` check. A token can have code at the same address on another chain (anvil account 0 at nonce 0 gives the same address on every anvil chain; CREATE2 and same-nonce testnet deploys do the same). With a wrong `CHAIN_ID` or a misrouted RPC URL, the indexer writes rows under the wrong `chain_id` and uses the wrong advisory-lock key, and nothing reports it.

**Evidence.** `apps/indexer/src/ingestion/ingestion-loop.ts:250-253`; no non-test call to `getChainId` or `eth_chainId` in `apps/indexer/src` or `packages/chain/src`; `packages/config/src/schemas.ts:83-85` only checks `CHAIN_ID >= 1`.

**Fix.** On start, call `eth_chainId` and fail with a fatal, typed error if it differs from `CHAIN_ID`. Add a unit test and update `docs/03` (startup checks).

### TST-1: No indexer chaos test for a full Postgres outage

- [ ] Fixed

**Problem.** Indexer DB-loss coverage is `pg_terminate_backend` of the lock session only, which leaves the pool and the DB up. The supervisor's DB-error retry is tested only with a fake. The API has a real DB-down test; the indexer, which matters more, does not.

**Evidence.** `two-instances.chaos.spec.ts:91-92`; `leader-lock.int.spec.ts:50`; `indexer-supervisor.spec.ts:98-103`; `apps/api/test/e2e/database-down.e2e.spec.ts:30`; the scenario table in `docs/06` has no DB-outage row.

**Fix.** Add a `db-outage` chaos scenario: stop the Postgres container under a running indexer, assert `/healthz` stays 200 and `/readyz` turns 503, start it again, and assert exact parity and `rowsAboveCheckpoint() === 0`. Add the row to `docs/06`.

### CI-1: Renovate cannot see many pinned versions

- [ ] Fixed

**Problem.** `renovate.json` has presets and one package rule, with no `customManagers`. The default managers cover the Dockerfiles, `docker-compose.yml`, Helm `values.yaml`, action SHAs, and `.nvmrc`. They do not cover:

- Makefile variables: `ENVOY_GATEWAY_VERSION`, `KPS_VERSION`, `LOKI_VERSION`, `ALLOY_VERSION`, `METRICS_SERVER_VERSION`, `K6_IMAGE`, `PROMETHEUS_IMAGE`, `KUBE_VERSION` (`Makefile:15-40`).
- Action `version:` inputs: Foundry `v1.8.6` (`ci.yml:67,90,123`) and Helm `v4.3.1` (`ci.yml:189`).
- The kubeconform URL and SHA-256 (`ci.yml:194-195`).
- Raw manifests: `deploy/local/anvil.yaml:30`, `postgres.yaml:45`, `kind-config.yaml:11`.

`docs/08:55` says Renovate manages "Helm chart versions in the Makefile/values", so this is doc/config drift. Foundry is pinned in five places and only the Compose copy is tracked.

**Fix.** Add regex `customManagers` with `# renovate: datasource=... depName=...` comments next to each pin, and a `kubernetes` manager file pattern for `deploy/local/*.yaml`. Or correct `docs/08` to say what is tracked by hand.

### CI-2: No security scanning in CI

- [ ] Fixed

**Problem.** The `images` job builds, checks the size budget, and smoke-tests, but has no vulnerability scan (Trivy or Grype) and no SBOM. Nothing lints the workflows (actionlint or zizmor). There is no CodeQL or dependency-review job. For a DevOps showcase this is the most visible missing CI signal. The existing hygiene is good (SHA-pinned actions, `permissions: contents: read`, `persist-credentials: false`, a checksum on kubeconform).

**Evidence.** `.github/workflows/ci.yml:133-176`; no scanner in `.github/` or `docs/`.

**Fix.** Add an image scan with a severity gate and an SBOM to `images`, a `zizmor` or `actionlint` step, and `dependency-review` on PRs. Document them in `docs/08` and add any new required check to the `main` ruleset.

## Low

### Indexer

#### IDX-2: A failed rewind is treated as a rejected range

- [ ] Fixed

`fetching = true` is set before `fetchRange` (`ingestion-loop.ts:167`) and is not cleared when `fetchRange` throws `AnchorMismatchError`. If the rewind's `getHeader` then times out, the error replaces `err` (`:216-219`) and `:225` classifies it as `range-rejected`, so the batch halves and the loop retries with no backoff. Repeated timeouts during a reorg shrink the batch toward 1 block; regrowth takes 10 successes per doubling. Correctness is not affected.

**Fix.** Clear `fetching` when the fetch throws, or classify the rewind error separately. Add a unit test for a rewind that times out (`ingestion-loop.spec.ts:359` covers only a generic failure).

#### IDX-3: Any RPC timeout halves the batch with no backoff

- [ ] Fixed

`classifyRpcError` maps every viem `TimeoutError` and any message containing "block range" to `range-rejected` (`packages/chain/src/rpc-error.ts:132-133,168`). A network blip, or a "block range beyond head" reply from a lagging node, halves the batch at once. `docs/03:83` says to halve on timeout, but `docs/03:104` lists timeouts as transient errors with backoff. Throughput only.

**Fix.** Decide one rule, make the code and both doc lines agree, and consider halving and backing off together.

#### IDX-4: `findRewindTarget` has no clamp; START_BLOCK is not checked on start

- [ ] Fixed

When `lastBlock - rewindBlocks <= startBlock - 1`, the walk is skipped and `floor` is returned with no `min(rewindTo, lastBlock)` (`reorg.ts:44-56`). If START_BLOCK was raised after a checkpoint exists, a rewind moves the checkpoint forward and the reorged rows at or below the old checkpoint are never deleted. If START_BLOCK was lowered, `[new START_BLOCK, old start)` is silently never indexed, which breaks invariant 1. The startup path returns a stored checkpoint without comparing it to `settings.startBlock` (`ingestion-loop.ts:255-256`). Both cases need operator error.

**Fix.** Clamp `rewindTo` to `lastBlock`, and fail on start when the stored checkpoint is below `START_BLOCK - 1` (or document the rule). Add unit tests.

#### IDX-5: Shutdown and the heartbeat do not reach inside `fetchRange`

- [ ] Fixed

`batch-fetcher.ts:75-83` fetches headers in sequential chunks of `RPC_BATCH_SIZE` (50) with no abort signal and no heartbeat. The loop beats only at `ingestion-loop.ts:139`. With `BATCH_SIZE` 2000 on a dense token, about 1.5 s per request already passes the 60 s liveness window, so the Pod restarts on the same range every time.

**Fix.** Pass the abort signal into `fetchRange` and beat the heartbeat between chunks.

#### IDX-6: The indexer readiness check can fill the pool when the DB hangs

- [ ] Fixed

`health.service.ts:70-76` races `pool.query('select 1')` against 2 s but never cancels the query, and the pool has `max: 10` with no connect timeout. A black-holed DB fills the free slots in about 45 s, and a later `tryAcquire` queues behind the stuck probes.

**Fix.** Use a short `query_timeout` or `statement_timeout` for the probe, or a dedicated client. Mostly solved by DB-1.

#### IDX-7: One `0x` answer from `eth_getCode` is fatal

- [ ] Fixed

After every non-fatal error the checkpoint is cleared and `start()` runs again, which repeats `getTokenCode` (`ingestion-loop.ts:145-146,223,252-253`). One `0x` from a badly synced or misbehaving node exits the process with code 1. This is tested as intended behavior (`ingestion-loop.spec.ts:391-401`), and a restart loop needs persistent bad answers.

**Fix.** Run the code check once per process, or retry a few times before the fatal error.

#### IDX-8: Small indexer polish items

- [ ] Fixed

- Deletes and inserts use `.returning({ logIndex })` only to count rows (`indexer.repository.ts:145-148,179-184`), so a deep rewind loads every deleted key into memory. Use `rowCount`.
- `inserted < rows.length` on a first-time commit would mean rows exist above the checkpoint, but nothing asserts or alerts on it (`ingestion-loop.ts:186`).
- `main.ts:91-93` redacts only `RPC_HTTP_URL` on the fatal path; `ingestion.service.ts:86-87` redacts both URLs.
- Optional: the parity tool compares only `(tx_hash, log_index)` (by design, `docs/03:160`). Comparing `block_hash` and `value` would also catch a stale-hash row or a decoding bug.

### API

#### API-2: Readiness shares the request pool; pool exhaustion reads as an outage

- [ ] Fixed

`/readyz` runs `select 1` on the same 10-connection pool as requests (`health.service.ts:45`, `database-check.ts:22`). Under load the probe can fail to get a connection and the Pod turns unready. pg-pool raises the same "timeout exceeded when trying to connect" for a full queue and a slow connect, and `database-unavailable.ts:22` treats both as an outage that `problem-details.filter.ts:99-101` logs at error level.

**Fix.** Give the probe its own connection (or a tiny pool), and tell pool exhaustion apart from an unreachable DB in the error mapping.

#### API-3: Behind the Gateway, a DB outage gives Envoy's 503

- [ ] Fixed

Readiness depends on the DB, so a DB outage makes every API Pod unready and clients get Envoy's "no healthy upstream" 503, not the problem+json 503 that `database-down.e2e.spec.ts` checks against the process directly. This is a defensible choice that `docs/02:163` does not describe.

**Fix.** Document what clients see in `docs/02`, or keep Pods ready during a DB outage so the API's own 503 is served.

#### API-4: Node's HTTP keep-alive timeout is shorter than Envoy's

- [ ] Fixed

`main.ts:80` only calls `app.listen`. Node closes idle sockets after 5 s, which is shorter than Envoy's default upstream idle timeout, a known source of occasional "upstream connection reset" 503s.

**Fix.** Set `server.keepAliveTimeout` above Envoy's upstream idle timeout and `headersTimeout` above that, or lower the idle timeout with a `BackendTrafficPolicy`.

#### API-5: No rate limiting and no `Cache-Control`

- [ ] Fixed

`httproute.yaml` and `deploy/local/gateway.yaml` have no traffic policy, and the controllers set no cache headers. Unauthenticated traffic goes straight to Postgres.

**Fix.** Add an Envoy Gateway `BackendTrafficPolicy` rate limit and short `Cache-Control` headers on `/v1/stats` and first pages.

#### API-6: `/v1/stats` runs `count(*)` on every request

- [ ] Fixed

`stats.repository.ts:46-49` counts in a REPEATABLE READ snapshot with no cache (`stats.service.ts:27-31`). This is a documented trade-off (`docs/02:184`) and fine for one testnet token, but the k6 mix sends 30% of requests to it.

**Fix.** Add a short in-memory TTL cache (a few seconds).

Optional: the k6 script (`deploy/load/api.js:45-56`) only fetches first pages; follow `nextCursor` for some iterations to load deep-cursor paths.

### Database and migrations

#### DB-2: No CI check for drift between `schema.ts` and the migrations

- [ ] Fixed

CI has no `drizzle-kit check` or generate-and-`git diff` step. Integration tests apply the SQL files, so behavioral drift fails, but an index or CHECK constraint added only to `schema.ts` passes CI.

**Fix.** Add a CI step that runs `pnpm db:generate` and fails on a diff.

#### DB-3: Migration safety for the pre-upgrade hook is not documented

- [ ] Fixed

All pending migrations run in one transaction (`packages/db/src/migrate.ts:14-15`) while the old Pods keep serving. `0001_stats_token_index.sql` is a plain `CREATE INDEX`, which blocks writes to `transfers` for the build, and `CONCURRENTLY` cannot run inside the transaction. No rule says migrations must stay compatible with the running version.

**Fix.** Add an "expand, then contract" rule and the `CONCURRENTLY` limitation to `docs/05` and the db README. Set `lock_timeout` for the migrate session (see K8S-4).

#### DB-4: Numeric columns accept negative values

- [ ] Fixed

`numeric(78,0)`, `block_number`, and `log_index` have no `>= 0` CHECK (`schema.ts:25-35`), while every hex column has a format CHECK (`:57-61`). The ingestion path cannot produce negatives, so this is consistency only.

**Fix.** Add non-negative CHECK constraints in a new migration.

#### DB-5: Secondary indexes leave out `token_address`

- [ ] Fixed

The indexes are `(chain_id, [from|to], block_number, log_index)`, while every query also filters on `token_address` (`transfers.repository.ts:92-94`). With one token per deployment this costs nothing, and multi-token is a non-goal (`docs/01:24`). The EXPLAIN test (`schema.int.spec.ts:176-186`) omits the token predicate.

**Fix.** Add the token predicate to the EXPLAIN test, and note in `docs/02` that multi-token needs `token_address` in the indexes.

#### DB-6: The `text` versus `bytea` choice is not recorded

- [ ] Fixed

Hashes and addresses are `0x`-prefixed lowercase `text` (`schema.ts:27-33`), about twice the key size of `bytea` in the PK and the from/to indexes. Defensible for readability, but `docs/02` gives no reason.

**Fix.** Add one sentence on the trade-off to `docs/02`.

Optional: the fixtures emit one `Transfer` per transaction (`SpamTransfers.s.sol:43-45`, `harness/token.ts:133-143`). A MockToken batch helper that emits several logs in one tx would add end-to-end coverage of that shape.

### Tests

#### TST-2: The multi-chunk header fetch is never run

- [ ] Fixed

`RPC_BATCH_SIZE` is 50, but no test uses `BATCH_SIZE` above 10 (`harness/world.ts:59`), so the chunk loop in `batch-fetcher.ts:75-83` runs once. There is no `batch-fetcher.spec.ts`. An index mix-up would throw `RangeInconsistentError`, so it cannot write wrong data, but production backfills will be the first to run it.

**Fix.** Add a `batch-fetcher` unit test with more than 50 distinct log blocks.

#### TST-3: The split-node RPC trade-off is not tested

- [ ] Fixed

`docs/03:149` names the `rpc-lagging-node` test as a backstop for a provider that answers `getLogs` from a lagging node and the header from a fresh one. That test returns `null` for the header too (`rpc.chaos.spec.ts:128-135`), which `range-consistency.ts:38-40` already rejects, so the silent-gap case never runs.

**Fix.** Add a case where the proxy returns `[]` for `getLogs` and forwards the header (`rpc-proxy.ts:91-99` supports this), and assert that `verify` reports the gap. Or correct `docs/03:149`.

#### TST-4: Only the kill tests check `rowsAboveCheckpoint`

- [ ] Fixed

The kill and graceful-shutdown tests assert `world.rowsAboveCheckpoint() === 0`, which catches a checkpoint running behind its data (re-processing that `ON CONFLICT DO NOTHING` would hide). The rpc, reorg, and ws chaos files do not.

**Fix.** Add the assertion to the parity helper so every chaos test runs it.

#### TST-5: The parity oracle's chunk loop is untested

- [ ] Fixed

Every parity call uses `chunkSize: 1000n` over ranges far below 1000 blocks (`world.ts:85`, `baseline.int.spec.ts:71`), so `fetchChainKeys` runs one iteration, and `verify-range.spec.ts` tests only `compareKeys` and `keyOf`.

**Fix.** Use a small chunk size in one parity call, or unit-test the loop.

#### TST-6: Tests inside a file depend on each other

- [ ] Fixed

Expected counts add up earlier tests (`ws.chaos.spec.ts` 1+10+40+20+20+10+30; `graceful-shutdown.chaos.spec.ts:69-81`), and `two-instances.chaos.spec.ts:86-87` reuses an instance from the previous test. Running one test with `-t` or reordering breaks them. `docs/06:79` says "No shared state between tests".

**Fix.** Compute expected counts from the chain at assertion time, or reword `docs/06:79` to allow ordered steps within a file.

#### TST-7: Fixed sleeps and wall-clock assertions remain

- [ ] Fixed

`graceful-shutdown.chaos.spec.ts:33` (`delay(300)`), `rpc.chaos.spec.ts:145-146` (`delay(3000)` then one snapshot), `ws-heads.int.spec.ts:45` (`setTimeout 100`), `ws.chaos.spec.ts:80` (`elapsed < 5000`), `graceful-shutdown.chaos.spec.ts:58-59`. Most are negative checks backed by later parity. They go against `docs/06:78`.

**Fix.** Replace with event- or metric-based waits where possible, and document the rest as allowed exceptions.

#### TST-8: The end-to-end confirmations check is race-prone

- [ ] Fixed

`baseline.int.spec.ts:108-119` waits for checkpoint >= `last`, then reads head and checkpoint. An indexer that ignored `CONFIRMATIONS` could still be at `last` at that moment. `range-planner.spec.ts:12-41` is the real guard.

**Fix.** Mine extra blocks and wait for a stable state before the assertion, or assert on the plan the indexer logs.

#### TST-9: Duplicated test helpers

- [ ] Fixed

Two `waitFor` helpers (`apps/api/test/e2e/harness/api.ts:65-76`, `apps/indexer/test/integration/harness/wait-for.ts:15-24`), two near-identical `postgres.ts` harnesses with the same pinned image digest ("Keep them in sync"), and `baseline.int.spec.ts:40-94` re-implements `harness/world.ts`.

**Fix.** Move the shared helpers into one test-utils location and use `World` in the baseline test.

Optional: the API pagination-under-writes test only appends rows above the walk (`transfers.e2e.spec.ts:81-91`). That matches the documented scope in `docs/06`; a delete-below-cursor case could document what keyset pagination does not promise.

### Kubernetes and observability

#### K8S-1: `IndexerStalled` fires for a standby process

- [ ] Fixed

A standby updates `head_block` but never sets `processed_block`, and prom-client exports the unset gauge as 0. The rule has no aggregation (`rules/gapless.rules.yaml:24-26`), so the standby's series matches. With `replicas: 1` and `Recreate` this only happens off-nominal, and no promtool case covers leader plus standby.

**Fix.** Aggregate per namespace (`max by (namespace) (changes(...))`) and add a promtool case with a leader and a standby.

#### K8S-2: Alert rules hard-code the namespace; `IndexerLagHigh` counts confirmations

- [ ] Fixed

`PodRestartsHigh` hard-codes `namespace="gapless"` (`gapless.rules.yaml:102`), and the file is included with `.Files.Get`, so it cannot be templated. `IndexerLagHigh` uses a fixed 50-block threshold on `head - processed`, where head is the raw chain head, so the lag includes `CONFIRMATIONS`; raising confirmations near 50 would make it fire permanently. The summary says "confirmed head", which does not match the metric.

**Fix.** Use a namespace matcher that works for every release, compare lag against confirmations (or export a confirmed-head lag), and fix the summary text.

#### K8S-3: `IndexerNoLeader` drops the namespace; `ApiHighErrorRate` has no traffic floor

- [ ] Fixed

`max(gapless_indexer_is_leader)` has no `by (namespace)` (`gapless.rules.yaml:37`), so with two environments in one Prometheus a healthy leader hides the other's outage, and the description names no namespace. `ApiHighErrorRate` (`:74-77`) pages critical on a pure ratio: 1 failure out of 10 requests in 5 minutes is enough.

**Fix.** Add `by (namespace)`, use `$labels.namespace` in the text, and add a minimum request-rate condition.

#### K8S-4: The migrate Job has no time bound

- [ ] Fixed

`migrate-job.yaml:13-15` sets only `backoffLimit` and `ttlSecondsAfterFinished`. `bin/migrate.ts:33-38` uses connect timeout 0, and there is no `lock_timeout`. A DDL lock wait would queue every later query on the table until Helm's 5-minute timeout, and a hook timeout leaves the Job Pod running.

**Fix.** Set `activeDeadlineSeconds`, a connect timeout, and `lock_timeout` for the migrate session.

#### K8S-5: The grace-period rule is kept by comments only

- [ ] Fixed

`terminationGracePeriodSeconds` is hard-coded to 30 (`indexer-deployment.yaml:30`, `api-deployment.yaml:32`) while `shutdownTimeoutMs` is a free value (`values.yaml:26-27`). Nothing fails the render if an operator raises it past 30 s.

**Fix.** Derive the grace period from the value (plus the API-1 drain delay), or `fail` in `_helpers.tpl` when it is too large.

#### K8S-6: `chart-lint` renders only one values combination

- [ ] Fixed

`Makefile:146-149` lints and renders only with `values-local.yaml`, so autoscaling disabled (the `replicas` field), `monitoring.enabled=false`, and `networkPolicy.enabled=false` are never schema-checked. The comment at `Makefile:18` ("The Prometheus image of that chart, for promtool") sits far above `PROMETHEUS_IMAGE` (`:35`).

**Fix.** Render and kubeconform a few `--set` combinations in `chart-lint`, and move the comment.

### CI, docs and repo

#### CI-3: The README status line is stale

- [ ] Fixed

`README.md:5` says "Phase 5 (API) done", while `docs/01:46` says Phase 8 is done. This breaks the README's own sync rule. The rest of the README rewrite is already Phase 10 work.

**Fix.** Update the status line now, and rewrite the README in Phase 10 as planned.

#### CI-4: CI does not enforce commitlint or fail on lint warnings

- [ ] Fixed

commitlint runs only in the lefthook `commit-msg` hook (`lefthook.yml:12-15`), which `--no-verify` skips. `.oxlintrc.json:5,12` set some rules to `warn`, and `pnpm lint` runs `oxlint` without `--deny-warnings`.

**Fix.** Lint the PR commit messages (or the PR title) in CI, and add `--deny-warnings`.

#### CI-5: Small doc and code inconsistencies

- [ ] Fixed

- `docs/06:12` says manifests run on "every PR touching deploy/", but `docs/08:24` says "No path filter", and the job has none.
- `docs/04:3` says "Last reviewed: 2026-11-04 (Phase 5 start) … Re-review whenever a phase starts", with no re-review for Phases 6–8.
- `Chart.yaml:5-6` says "Bump it when a template changes", but the version is still `0.1.0` after several template commits.
- `docs/03:83` versus `:104` on timeouts (see IDX-3), and `docs/03:149` (see TST-3).

**Fix.** Correct each line.

#### CI-6: Copy-pasted CI setup and no Foundry cache

- [ ] Fixed

The checkout, pnpm, Node, and install block repeats four times (`ci.yml:20-29,38-47,54-63,77-86`). The Foundry setup and `forge soldeer install && forge build` repeat three times with no cache for `contracts/dependencies` or `out/`, so a version bump can miss a copy.

**Fix.** Extract a local composite action and cache the Foundry outputs.

#### CI-7: Agent files are visible or not ignored

- [ ] Fixed

`CLAUDE.md` is tracked and the README links to "Contributor and agent rules". `AGENT-HANDOFF.md` and `KUBERNETES-NOTES.md` are untracked but not in `.gitignore` or `.prettierignore`, so they can be committed by accident and a local `pnpm format:check` reads them.

**Fix.** Ignore the local note files. Decide how to present `CLAUDE.md` in the polished README, and be ready to explain the workflow in interviews.

Optional: only one ADR covers the app itself. The rationale for NestJS, Drizzle, oxlint, Loki and Alloy lives inline in `docs/04`; a few short ADRs would make those choices easier to find.

## Phase 9 notes

Handle these while building Phase 9, because they depend on the AWS setup.

- [ ] **Session-level advisory lock versus poolers.** The single writer uses session-level `pg_try_advisory_lock` (`leader-lock.ts:74-76`). A pooler in transaction mode (PgBouncer, RDS Proxy) breaks that. The checkpoint fence still prevents gaps and duplicates (two writers would get fatal restarts), but state "no transaction-mode pooler between the indexer and Postgres" as a deployment rule in `docs/03` and `docs/07`.
- [ ] **Server-side TCP keepalives.** After a hard client loss, Postgres keeps the dead session, and its advisory lock, until server-side keepalive notices it (about 2 h with OS defaults). Set `tcp_keepalives_idle`, `tcp_keepalives_interval`, and `tcp_keepalives_count` in the RDS parameter group (and on local Postgres). Add a `pg_terminate_backend` step for a stale lock to the `IndexerNoLeader` runbook, and note in `docs/03:37` that lock release depends on the server detecting the drop.
- [ ] **`gateway.namespace` has two meanings.** It is both the HTTPRoute `parentRef` namespace (`httproute.yaml:12`) and the namespace of the Envoy proxy Pods in the NetworkPolicy (`networkpolicy.yaml:17-23`). Envoy Gateway runs proxies in the controller namespace by default, so a Gateway elsewhere on EKS would make the policy block all API traffic. Add a separate value (defaulting to `gateway.namespace`) and correct `docs/07:47`.
- [ ] **Spread API Pods across nodes.** `api-deployment.yaml` has no `topologySpreadConstraints`. On the Spot node group, add one (`whenUnsatisfiable: ScheduleAnyway`) so both minimum replicas do not share a node.
- [ ] **Secret rotation.** The checksum annotations cover only the ConfigMap, so a Secret rotated by ESO does not restart the Pods. Add a reloader or a checksum on the ExternalSecret.
