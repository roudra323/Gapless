# 09 — Observability

## Metrics

- Library: `@prometheus-io/client` (formerly `prom-client`). One `Registry` per process, created with `createMetricsRegistry()` from `packages/observability`, which adds `collectDefaultMetrics()` (process and Node runtime metrics: CPU, memory, event loop lag, GC). Apps import `Counter`, `Gauge` and `Histogram` from `@gapless/observability`, not from the library, so there is one copy of it.
- Served at `GET /metrics` on `METRICS_PORT` (9464), **never** through the Gateway.
- Naming: `gapless_<area>_<name>_<unit>`. Counters end in `_total`, durations are in `_seconds`, and sizes in `_bytes`.
- **Label cardinality rule:** labels must have small, bounded value sets. Never use an address, a tx hash, a block number, or a raw URL path as a label. HTTP routes use the **route template** (`/v1/addresses/:address/transfers`).

### Indexer metrics (this list is the contract; keep it in sync with the code)

Defined in one place, `apps/indexer/src/metrics/indexer-metrics.ts` (the `IndexerMetrics` provider), and served on the indexer's `/metrics`. `indexer-metrics.spec.ts` reads this table and fails if a name, type or label set differs from the code. Histogram buckets: batch duration `0.05 … 30` s, RPC duration `0.01 … 10` s (the RPC timeout). The batch outcomes start at 0 for both `result` values, so the first error shows as an increase.

Where the values come from (the code calls the `record*` methods of `IndexerMetrics`, never a metric by name):

- `head_block`: every head change in `HeadTracker` (poll or WebSocket), on the leader and on a standby. It doesn't depend on the database, so `IndexerStalled` still fires when the DB is down.
- `processed_block`: the checkpoint the loop read at the start of a term, committed, or rewound to.
- `lag_blocks`: head − processed, updated when either changes, never below 0. A standby has no checkpoint and reports 0.
- `batches_total`: one per planned range. `ok` when it committed; `error` when it didn't (range rejected by the RPC, reorg found, RPC or DB error). A shutdown or a lost lock counts as neither, and a failure before a range is planned (the start step) isn't a batch.
- `events_indexed_total` and `batch_duration_seconds`: on each committed batch (fetch + write time).
- `batch_size_blocks`: at the top of every loop cycle. `reorgs_total`: after each finished rewind.
- `is_leader` and `last_tick_timestamp_seconds`: from the same `LeaderStatus` and `Heartbeat` objects that `/readyz` and `/healthz` read, so a gauge and a probe can't disagree.
- `ws_connected` and `ws_reconnects_total`: from `HeadTracker` (docs/03 "HeadTracker", including the stall rule). Poll-only mode (no `RPC_WS_URL`) reports `ws_connected = 0`; `IndexerWsDown` is `info` only, so that is not paged.
- `rpc_requests_total` and `rpc_request_duration_seconds`: the `onCall` observer of `createRpcClient` and `subscribeNewHeads` (packages/chain) reports every JSON-RPC call. A call inside a JSON-RPC batch counts once, with its own method, and its time includes the wait for the whole batch. `rate_limited` = HTTP 429 or a rate-limit JSON-RPC error (`isRateLimited`); every other failure (including a timeout) is `error`. `method` is one of the indexer's own calls (`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_getCode`, `eth_subscribe`).

| Metric                                        | Type      | Labels                                                                         | Meaning                             |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `gapless_indexer_head_block`                  | gauge     | —                                                                              | latest chain head seen              |
| `gapless_indexer_processed_block`             | gauge     | —                                                                              | checkpoint `last_block`             |
| `gapless_indexer_lag_blocks`                  | gauge     | —                                                                              | head − processed                    |
| `gapless_indexer_events_indexed_total`        | counter   | —                                                                              | rows inserted (excluding conflicts) |
| `gapless_indexer_batches_total`               | counter   | `result` = `ok`\|`error`                                                       | batch outcomes                      |
| `gapless_indexer_batch_duration_seconds`      | histogram | —                                                                              | per-batch time (fetch + write)      |
| `gapless_indexer_batch_size_blocks`           | gauge     | —                                                                              | current adaptive batch size         |
| `gapless_indexer_reorgs_total`                | counter   | —                                                                              | rewinds performed                   |
| `gapless_indexer_is_leader`                   | gauge     | —                                                                              | 1 if holding the advisory lock      |
| `gapless_indexer_ws_connected`                | gauge     | —                                                                              | 1 if the WS head feed is healthy    |
| `gapless_indexer_ws_reconnects_total`         | counter   | —                                                                              | WS reconnect attempts               |
| `gapless_indexer_last_tick_timestamp_seconds` | gauge     | —                                                                              | loop heartbeat (liveness)           |
| `gapless_rpc_requests_total`                  | counter   | `method`, `transport` = `http`\|`ws`, `result` = `ok`\|`error`\|`rate_limited` |                                     |
| `gapless_rpc_request_duration_seconds`        | histogram | `method`, `transport`                                                          |                                     |

### API metrics

Defined in `apps/api/src/metrics/api-metrics.ts` (the `ApiMetrics` provider) and served on the API's `/metrics` on `METRICS_PORT`. `api-metrics.spec.ts` checks this table against the code.

- `http_requests_total` and `http_request_duration_seconds`: `HttpMetricsMiddleware`, on every request on the public port, when the response closes. `route` is the Express route template, or `unmatched` for a request no controller matched (a 404), so a scanned URL can't create a series. Probes and `/metrics` are on `METRICS_PORT`, outside Nest, and are not counted.
- `db_query_duration_seconds`: `ApiMetrics.timeQuery` around each repository read, also when it fails. `query` is one of `recent_transfers`, `address_transfers` (both sides of `direction=all` together), `stats`.

| Metric                                  | Type      | Labels                                                |
| --------------------------------------- | --------- | ----------------------------------------------------- |
| `gapless_http_requests_total`           | counter   | `method`, `route`, `status_class` (`2xx`/`4xx`/`5xx`) |
| `gapless_http_request_duration_seconds` | histogram | `method`, `route`                                     |
| `gapless_db_query_duration_seconds`     | histogram | `query` (a fixed name, such as `recent_transfers`)    |

## Alerts (`PrometheusRule`, in the Helm chart)

The rules live in `deploy/helm/gapless/rules/gapless.rules.yaml` (plain Prometheus rule format), and `deploy/monitoring/tests/gapless.rules.test.yaml` unit-tests every alert with promtool (`make rules-test`): one case where it fires, one where it must stay quiet. `changes()`, not `increase()`, on the block gauges: a reorg rewind moves the checkpoint down, and `increase()` would read that as a counter reset. `absent()` makes `IndexerNoLeader` fire when no indexer is scraped at all.

| Alert              | Expression (sketch)                                                                                   | For | Severity                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --- | ------------------------ |
| `IndexerLagHigh`   | `gapless_indexer_lag_blocks > 50`                                                                     | 5m  | warning                  |
| `IndexerStalled`   | `changes(gapless_indexer_processed_block[10m]) == 0 and changes(gapless_indexer_head_block[10m]) > 0` | 0m  | critical                 |
| `IndexerNoLeader`  | `max(gapless_indexer_is_leader) < 1 or absent(gapless_indexer_is_leader)`                             | 2m  | critical                 |
| `IndexerWsDown`    | `gapless_indexer_ws_connected == 0`                                                                   | 5m  | info (polling covers it) |
| `RpcErrorRateHigh` | error ratio of `gapless_rpc_requests_total` over 5m > 0.2                                             | 10m | warning                  |
| `ApiHighErrorRate` | 5xx ratio over 5m > 0.05                                                                              | 5m  | critical                 |
| `ApiLatencyHigh`   | p95 of `gapless_http_request_duration_seconds` > 0.5s                                                 | 10m | warning                  |
| `PodRestartsHigh`  | `increase(kube_pod_container_status_restarts_total{namespace="gapless"}[30m]) > 3`                    | 0m  | warning                  |

Each alert has `summary` and `description` annotations and a `runbook_url` pointing to its section in `docs/runbooks.md` (meaning, first checks, fix).

**Alertmanager routing** (`alertmanager.config` in `deploy/monitoring/kps-values.yaml`): `warning` and `critical` alerts go to one Discord receiver (`discord_configs`), grouped by `alertname` and `namespace` (`group_wait` 30s, `group_interval` 5m, `repeat_interval` 4h), with `send_resolved: true` so the channel also shows recovery. `info` alerts (`IndexerWsDown`) and the always-firing `Watchdog` go to a `null` receiver and stay in the UI only. The chart's default inhibit rules are kept (a `critical` alert silences the `warning` of the same alert). The webhook URL is a secret, read from a file (`webhook_url_file`): a local Secret on kind (`docs/07`), Secrets Manager via ESO on EKS. Never commit it.

## Grafana dashboard (`deploy/helm/gapless/dashboards/gapless.json`)

Provisioned via a ConfigMap with the `grafana_dashboard: "1"` label. Edit it in the Grafana UI, then export it to JSON and commit. The JSON in the repo is the source of truth.

The rows:

1. **Indexer health:** head vs processed (one graph), lag, events/sec, leader status, WS connected, reorgs, batch size.
2. **RPC:** request rate by method, error ratio, p95 latency.
3. **API:** RPS by route, p50/p95/p99 latency, 5xx rate.
4. **Platform:** pod CPU/memory vs requests, restarts, HPA replica count.
5. **Logs** (from Loki, through the `logs` data source variable): log lines per second by component and level (`| json level`), the indexer's `warn` and higher lines (`{namespace="$namespace", app_kubernetes_io_component="indexer"} | json | level=~"warn|error|fatal"`; pino writes `level` as a string), and the API's `error` and higher lines (each has its `reqId`).

Use a `$namespace` template variable, and use `$__rate_interval` in rate queries.

## Logs

- pino JSON to stdout, one line per entry. Base fields: `level`, `time` (ISO), `service` (`api`/`indexer`), `version` (Git SHA), `msg`.
- In the cluster, **Grafana Alloy** collects pod stdout and ships it to **Loki** (Phase 8). Labels come from Kubernetes metadata only (`namespace`, `pod`, `container`, `app_kubernetes_io_name`, `app_kubernetes_io_component`; Alloy also adds `job` and `instance`, and Loki adds `service_name`); never turn a log field such as `reqId` or an address into a Loki label (the same cardinality rule as metrics). Query JSON fields with `| json`.
- The shared logger still adds a GCP Cloud Logging `severity` field (from Phase 3, `GCP_SEVERITY` in `packages/observability`). It has no use on AWS and is removed in Phase 9 (`adr/0003`).
- The API adds a request-scoped `reqId`, honoring an incoming `x-request-id` header or generating one, and returns it in the response header (`apps/api/src/request-id.ts`). An incoming ID is kept only if it matches `^[A-Za-z0-9._:-]{1,128}$`, so a client can't inject a line break into the logs; otherwise a UUID is used. Every log line written during a request has `reqId` (pino-http `quietReqLogger`), and the one line per request (`request completed` / `request errored`) adds `req: { method, url }`, `res: { statusCode }` and `responseTime` in ms. Headers are never logged. Probes on `METRICS_PORT` are not logged (they bypass Nest).
- Redact: `DATABASE_URL`, `RPC_*`, `authorization` headers.
- NestJS apps log through nestjs-pino with the shared `loggerOptions` (`packages/observability`) and `wrapSerializers: false`. pino-http otherwise passes an already-serialized error to `errWithCause`, which then drops the inner errors of a cause. An app that logs requests must then set the `req`/`res` serializers itself.
- NestJS apps boot with `abortOnError: false`, so a boot error reaches the entrypoint, which logs it as `fatal` JSON and exits 1 (Nest's default calls `process.abort()`, with no JSON log and exit code 134).

## Tracing

Out of scope until the optional phase (after Phase 9 works). When added, use the OpenTelemetry SDK with OTLP export. Record the choice of instrumentation (OTel vs `@nestjs/observe`) in an ADR first.
