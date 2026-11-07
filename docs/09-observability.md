# 09 — Observability

## Metrics

- Library: `@prometheus-io/client` (formerly `prom-client`). One `Registry` per process, created with `createMetricsRegistry()` from `packages/observability`, which adds `collectDefaultMetrics()` (process and Node runtime metrics: CPU, memory, event loop lag, GC). Apps import `Counter`, `Gauge` and `Histogram` from `@gapless/observability`, not from the library, so there is one copy of it.
- Served at `GET /metrics` on `METRICS_PORT` (9464), **never** through the Gateway.
- Naming: `gapless_<area>_<name>_<unit>`. Counters end in `_total`, durations are in `_seconds`, and sizes in `_bytes`.
- **Label cardinality rule:** labels must have small, bounded value sets. Never use an address, a tx hash, a block number, or a raw URL path as a label. HTTP routes use the **route template** (`/v1/addresses/:address/transfers`).

### Indexer metrics (this list is the contract; keep it in sync with the code)

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

| Metric                                  | Type      | Labels                                                |
| --------------------------------------- | --------- | ----------------------------------------------------- |
| `gapless_http_requests_total`           | counter   | `method`, `route`, `status_class` (`2xx`/`4xx`/`5xx`) |
| `gapless_http_request_duration_seconds` | histogram | `method`, `route`                                     |
| `gapless_db_query_duration_seconds`     | histogram | `query` (a fixed name, such as `recent_transfers`)    |

## Alerts (`PrometheusRule`, in the Helm chart)

| Alert              | Expression (sketch)                                                                                     | For | Severity                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --- | ------------------------ |
| `IndexerLagHigh`   | `gapless_indexer_lag_blocks > 50`                                                                       | 5m  | warning                  |
| `IndexerStalled`   | `increase(gapless_indexer_processed_block[10m]) == 0 and increase(gapless_indexer_head_block[10m]) > 0` | 0m  | critical                 |
| `IndexerNoLeader`  | `max(gapless_indexer_is_leader) < 1`                                                                    | 2m  | critical                 |
| `IndexerWsDown`    | `gapless_indexer_ws_connected == 0`                                                                     | 5m  | info (polling covers it) |
| `RpcErrorRateHigh` | error ratio of `gapless_rpc_requests_total` over 5m > 0.2                                               | 10m | warning                  |
| `ApiHighErrorRate` | 5xx ratio over 5m > 0.05                                                                                | 5m  | critical                 |
| `ApiLatencyHigh`   | p95 of `gapless_http_request_duration_seconds` > 0.5s                                                   | 10m | warning                  |
| `PodRestartsHigh`  | `increase(kube_pod_container_status_restarts_total{namespace="gapless"}[30m]) > 3`                      | 0m  | warning                  |

Each alert has `summary` and `description` annotations and a `runbook_url` pointing to a section in `docs/runbooks.md` (create that in phase 8 with one short section per alert: meaning, first checks, fix).

**Alertmanager routing (Phase 8):** route `warning` and `critical` alerts to one chat webhook receiver (Discord or Slack), grouped by `alertname`, with `send_resolved: true` so the channel also shows recovery. `info` alerts (`IndexerWsDown`) stay in the UI only. The webhook URL is a secret: a local Secret on kind, Secrets Manager via ESO on EKS. Never commit it.

## Grafana dashboard (`deploy/monitoring/dashboards/gapless.json`)

Provisioned via a ConfigMap with the `grafana_dashboard: "1"` label. Edit it in the Grafana UI, then export it to JSON and commit. The JSON in the repo is the source of truth.

The rows:

1. **Indexer health:** head vs processed (one graph), lag, events/sec, leader status, WS connected, reorgs, batch size.
2. **RPC:** request rate by method, error ratio, p95 latency.
3. **API:** RPS by route, p50/p95/p99 latency, 5xx rate.
4. **Platform:** pod CPU/memory vs requests, restarts, HPA replica count.
5. **Logs:** a Loki panel with the indexer's `warn` and higher lines (`{namespace="$namespace", app_kubernetes_io_component="indexer"} | json | level=~"warn|error|fatal"`; pino writes `level` as a string label), next to the lag graph.

Use a `$namespace` template variable, and use `$__rate_interval` in rate queries.

## Logs

- pino JSON to stdout, one line per entry. Base fields: `level`, `time` (ISO), `service` (`api`/`indexer`), `version` (Git SHA), `msg`.
- In the cluster, **Grafana Alloy** collects pod stdout and ships it to **Loki** (Phase 8). Labels come from Kubernetes metadata only (namespace, pod, container, `app.kubernetes.io/component`); never turn a log field such as `reqId` or an address into a Loki label (the same cardinality rule as metrics). Query JSON fields with `| json`.
- The shared logger still adds a GCP Cloud Logging `severity` field (from Phase 3, `GCP_SEVERITY` in `packages/observability`). It has no use on AWS and is removed in Phase 9 (`adr/0003`).
- The API adds a request-scoped `reqId`, honoring an incoming `x-request-id` header or generating one, and returns it in the response header (`apps/api/src/request-id.ts`). An incoming ID is kept only if it matches `^[A-Za-z0-9._:-]{1,128}$`, so a client can't inject a line break into the logs; otherwise a UUID is used. Every log line written during a request has `reqId` (pino-http `quietReqLogger`), and the one line per request (`request completed` / `request errored`) adds `req: { method, url }`, `res: { statusCode }` and `responseTime` in ms. Headers are never logged. Probes on `METRICS_PORT` are not logged (they bypass Nest).
- Redact: `DATABASE_URL`, `RPC_*`, `authorization` headers.
- NestJS apps log through nestjs-pino with the shared `loggerOptions` (`packages/observability`) and `wrapSerializers: false`. pino-http otherwise passes an already-serialized error to `errWithCause`, which then drops the inner errors of a cause. An app that logs requests must then set the `req`/`res` serializers itself.
- NestJS apps boot with `abortOnError: false`, so a boot error reaches the entrypoint, which logs it as `fatal` JSON and exits 1 (Nest's default calls `process.abort()`, with no JSON log and exit code 134).

## Tracing

Out of scope until the optional phase (after Phase 9 works). When added, use the OpenTelemetry SDK with OTLP export. Record the choice of instrumentation (OTel vs `@nestjs/observe`) in an ADR first.
