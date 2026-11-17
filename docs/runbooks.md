# Runbooks

One section per alert in `deploy/helm/gapless/rules/gapless.rules.yaml` (`docs/09` "Alerts"). Each alert's `runbook_url` links here. Every section has the same parts: what the alert means, the first checks, and the fix.

The commands use the local cluster (`kind-gapless`, namespace `gapless`). On EKS, use that cluster's context. Grafana's **Gapless** dashboard shows every metric named below.

```bash
K="kubectl --context kind-gapless -n gapless"
```

## IndexerLagHigh

**Severity:** warning. **Fires when:** `gapless_indexer_lag_blocks > 50` for 5 minutes.

**Meaning:** the indexer is more than 50 blocks behind the confirmed head. It still works (otherwise `IndexerStalled` fires), but too slowly, or it is catching up after downtime.

**First checks:**

1. Dashboard, "Head vs processed block": is the gap closing (catch-up after a restart) or growing?
2. "RPC" row: a high error ratio or p95 latency means the provider is slow or limits us (see `RpcErrorRateHigh`).
3. "Batch size (blocks)": the adaptive batch size shrinks after RPC errors, so each step covers fewer blocks.
4. Logs: `$K logs deploy/gapless-indexer --since 15m | grep -E '"level":"(warn|error)"'`.

**Fix:** if the gap is closing, wait. If the RPC is the cause, fix it as in `RpcErrorRateHigh`. If the chain is simply faster than the indexer, raise `BATCH_SIZE` (`config.batchSize` in the chart values) within the provider's `getLogs` limit.

## IndexerStalled

**Severity:** critical. **Fires when:** the chain head changed in the last 10 minutes but the checkpoint (`gapless_indexer_processed_block`) did not.

**Meaning:** the indexer sees new blocks but commits nothing. The data in the API is getting old.

**First checks:**

1. `$K get pods -l app.kubernetes.io/component=indexer`: is the Pod `Running` and `1/1`? Readiness needs the leader lock and the DB.
2. Logs: `$K logs deploy/gapless-indexer --since 15m | grep -E '"level":"(warn|error|fatal)"'`. Look for `indexing step failed, retrying after backoff` and the error message after it.
3. The database: `$K get pods -l app.kubernetes.io/name=postgres` (kind), or the RDS console (EKS). A missing table shows as `Failed query … indexer_checkpoints`: the migrate Job did not run.
4. The RPC: a range the provider rejects again and again shows as `batches_total{result="error"}` going up.

**Fix:** repair the dependency that the logs name (DB, RPC, migrations). The indexer retries forever with backoff and resumes from the checkpoint by itself; no data is lost and nothing needs to be replayed. If the Pod is stuck, `$K rollout restart deploy/gapless-indexer` (safe: `Recreate` and the checkpoint).

## IndexerNoLeader

**Severity:** critical. **Fires when:** no indexer has held the advisory lock for 2 minutes, or no indexer is scraped at all.

**Meaning:** nothing is indexed. The API still answers from the existing data.

**First checks:**

1. `$K get deploy,pods -l app.kubernetes.io/component=indexer`: is the Deployment scaled to 0, or is the Pod crash-looping or `Pending`?
2. `$K describe pod -l app.kubernetes.io/component=indexer`: events such as `ImagePullBackOff`, `CrashLoopBackOff` or `OOMKilled`.
3. Logs of the last run: `$K logs deploy/gapless-indexer --previous --tail 20`. A `fatal` line names the cause (for example `TOKEN_ADDRESS … has no contract code`).
4. If the Pod runs but is not the leader: another session holds the lock. Look for a second indexer (an old Pod, or a local `pnpm indexer:start` against the same DB).

**Fix:** start the indexer again (`$K scale deploy/gapless-indexer --replicas 1`), or fix the crash that the logs show. Never run two indexers to "help": the lock lets only one write, and the second one only waits.

**Demo:** this is the alert of the kill-pod demo in `docs/07`.

## IndexerWsDown

**Severity:** info (not sent to the chat). **Fires when:** `gapless_indexer_ws_connected == 0` for 5 minutes.

**Meaning:** the WebSocket head feed is down or stalled. The indexer keeps working on the `POLL_INTERVAL_MS` poll, only a little later (`docs/03` "HeadTracker"). With no `RPC_WS_URL` (poll-only mode) this alert is always active; that is expected.

**First checks:** logs for `ws head feed stalled, reconnecting` or reconnect errors; `gapless_indexer_ws_reconnects_total` on the dashboard; the provider's WebSocket status.

**Fix:** usually none: the indexer reconnects with backoff by itself. If the provider's WebSocket endpoint is broken for a long time, remove `RPC_WS_URL` from the Secret to run poll-only.

## RpcErrorRateHigh

**Severity:** warning. **Fires when:** more than 20% of the indexer's RPC calls failed or were rate limited, for 10 minutes.

**Meaning:** the RPC provider is failing or limits us. The indexer retries, so it slows down; `IndexerLagHigh` often follows.

**First checks:**

1. Dashboard "RPC" row: which `method` fails, and is it `error` or `rate_limited`? (`sum by (method, result) (rate(gapless_rpc_requests_total[5m]))` in Prometheus.)
2. Logs: the RPC error messages after `indexing step failed`.
3. The provider's status page and your plan's request limits.

**Fix:** `rate_limited`: lower the load (a larger `POLL_INTERVAL_MS`, a smaller `BATCH_SIZE`) or raise the plan. `error` on `eth_getLogs` only: the range may be too large for the provider; lower `BATCH_SIZE`. Provider outage: switch `RPC_HTTP_URL` in the Secret to another provider (the indexer is safe to restart).

## ApiHighErrorRate

**Severity:** critical. **Fires when:** more than 5% of API requests returned 5xx for 5 minutes.

**Meaning:** users get errors. 4xx (bad input, unknown routes) never count.

**First checks:**

1. Dashboard "API" row: which `route` returns 5xx?
2. Logs: `$K logs -l app.kubernetes.io/component=api --since 15m | grep '"level":"error"'`. Each error line has the request ID.
3. The database: the API reads only from Postgres. `$K get pods` for `/readyz` failures (Pods `0/1`).

**Fix:** if the DB is down, repair it; the API Pods become ready again by themselves. If one route fails after a deploy, roll back: `helm --kube-context kind-gapless -n gapless rollback gapless`.

## ApiLatencyHigh

**Severity:** warning. **Fires when:** the p95 API request time is above 0.5 s for 10 minutes.

**First checks:**

1. Dashboard "API" row: one route, or all of them?
2. `gapless_db_query_duration_seconds` by `query` in Prometheus: is one query slow?
3. "Platform" row: is API CPU near its request? Did the HPA scale up (`API replicas (HPA)`), or is it at its maximum?

**Fix:** a slow query: check its index in `packages/db` and run `EXPLAIN ANALYZE`. CPU-bound: the HPA adds Pods up to `maxReplicas`; raise it, or the CPU request, if it stays at the maximum.

## PodRestartsHigh

**Severity:** warning. **Fires when:** a container in the `gapless` namespace restarted more than 3 times in 30 minutes.

**First checks:**

1. `$K get pods`: which Pod, and its `RESTARTS` count.
2. `$K describe pod <pod>`: `Last State` shows the reason (`OOMKilled`, `Error`, exit code), and the events show failed probes.
3. `$K logs <pod> --previous --tail 30`: the last lines before the restart.

**Fix:** `OOMKilled`: raise the memory limit in the chart values. Liveness failures: find out why the process hangs (the indexer's heartbeat, `docs/03` "Health"); do not just loosen the probe. A crash at startup: the config error in the `fatal` log line.
