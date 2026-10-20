# 09 — Observability

## Metrics

- Library: `prom-client`. One `Registry` per process, created in `packages/observability`, plus `collectDefaultMetrics()` (process and Node runtime metrics).
- Served at `GET /metrics` on `METRICS_PORT` (9464), **never** through the Gateway.
- Naming: `gapless_<area>_<name>_<unit>`. Counters end in `_total`, durations are in `_seconds`, and sizes in `_bytes`.
- **Label cardinality rule:** labels must have small, bounded value sets. Never use an address, a tx hash, a block number, or a raw URL path as a label. HTTP routes use the **route template** (`/v1/addresses/:address/transfers`).

### Indexer metrics (this list is the contract; keep it in sync with the code)
| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `gapless_indexer_head_block` | gauge | — | latest chain head seen |
| `gapless_indexer_processed_block` | gauge | — | checkpoint `last_block` |
| `gapless_indexer_lag_blocks` | gauge | — | head − processed |
| `gapless_indexer_events_indexed_total` | counter | — | rows inserted (excluding conflicts) |
| `gapless_indexer_batches_total` | counter | `result` = `ok`\|`error` | batch outcomes |
| `gapless_indexer_batch_duration_seconds` | histogram | — | per-batch time (fetch + write) |
| `gapless_indexer_batch_size_blocks` | gauge | — | current adaptive batch size |
| `gapless_indexer_reorgs_total` | counter | — | rewinds performed |
| `gapless_indexer_is_leader` | gauge | — | 1 if holding the advisory lock |
| `gapless_indexer_ws_connected` | gauge | — | 1 if the WS head feed is healthy |
| `gapless_indexer_ws_reconnects_total` | counter | — | WS reconnect attempts |
| `gapless_indexer_last_tick_timestamp_seconds` | gauge | — | loop heartbeat (liveness) |
| `gapless_rpc_requests_total` | counter | `method`, `transport` = `http`\|`ws`, `result` = `ok`\|`error`\|`rate_limited` | |
| `gapless_rpc_request_duration_seconds` | histogram | `method`, `transport` | |

### API metrics
| Metric | Type | Labels |
|---|---|---|
| `gapless_http_requests_total` | counter | `method`, `route`, `status_class` (`2xx`/`4xx`/`5xx`) |
| `gapless_http_request_duration_seconds` | histogram | `method`, `route` |
| `gapless_cache_requests_total` | counter | `cache` (`stats`/`recent`), `result` = `hit`\|`miss`\|`error` |
| `gapless_db_query_duration_seconds` | histogram | `query` (a fixed name, such as `recent_transfers`) |

## Alerts (`PrometheusRule`, in the Helm chart)

| Alert | Expression (sketch) | For | Severity |
|---|---|---|---|
| `IndexerLagHigh` | `gapless_indexer_lag_blocks > 50` | 5m | warning |
| `IndexerStalled` | `increase(gapless_indexer_processed_block[10m]) == 0 and increase(gapless_indexer_head_block[10m]) > 0` | 0m | critical |
| `IndexerNoLeader` | `max(gapless_indexer_is_leader) < 1` | 2m | critical |
| `IndexerWsDown` | `gapless_indexer_ws_connected == 0` | 5m | info (polling covers it) |
| `RpcErrorRateHigh` | error ratio of `gapless_rpc_requests_total` over 5m > 0.2 | 10m | warning |
| `ApiHighErrorRate` | 5xx ratio over 5m > 0.05 | 5m | critical |
| `ApiLatencyHigh` | p95 of `gapless_http_request_duration_seconds` > 0.5s | 10m | warning |
| `PodRestartsHigh` | `increase(kube_pod_container_status_restarts_total{namespace="gapless"}[30m]) > 3` | 0m | warning |

Each alert has `summary` and `description` annotations and a `runbook_url` pointing to a section in `docs/runbooks.md` (create that in phase 8 with one short section per alert: meaning, first checks, fix).

Alertmanager routing is optional. Showing an alert firing in the Prometheus or Grafana UI is enough for the demo.

## Grafana dashboard (`deploy/monitoring/dashboards/gapless.json`)

Provisioned via a ConfigMap with the `grafana_dashboard: "1"` label. Edit it in the Grafana UI, then export it to JSON and commit. The JSON in the repo is the source of truth.

The rows:
1. **Indexer health:** head vs processed (one graph), lag, events/sec, leader status, WS connected, reorgs, batch size.
2. **RPC:** request rate by method, error ratio, p95 latency.
3. **API:** RPS by route, p50/p95/p99 latency, 5xx rate, cache hit ratio.
4. **Platform:** pod CPU/memory vs requests, restarts, HPA replica count.

Use a `$namespace` template variable, and use `$__rate_interval` in rate queries.

## Logs

- pino JSON to stdout, one line per entry. Base fields: `level`, `time` (ISO), `service` (`api`/`indexer`), `version` (Git SHA), `msg`.
- On GKE, Cloud Logging ingests stdout automatically. Map pino levels to the GCP `severity` field (via a pino `formatters.level`) so severity filtering works.
- The API adds a request-scoped `reqId`, honoring an incoming `x-request-id` header or generating one, and returns it in the response header.
- Redact: `DATABASE_URL`, `RPC_*`, `authorization` headers.
- Optional later phase: Loki + Promtail/Alloy in kind for logs in Grafana.

## Tracing
Out of scope until the optional phase. When added, use the OpenTelemetry SDK with OTLP export. Record the choice of instrumentation (OTel vs `@nestjs/observe`) in an ADR first.
