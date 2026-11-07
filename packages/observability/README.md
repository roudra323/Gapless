# `packages/observability` — `@gapless/observability`

The pino logger config, the internal health server, and the metrics registry. Framework-free.

- **Built in:** Phase 3 (pino logger config), Phase 5 (health server, moved from the indexer), Phase 6 (metrics)
- **Read first:** `docs/09-observability.md`

## Usage

```ts
import { createLogger, loggerOptions } from '@gapless/observability';

const logger = createLogger({
  service: 'indexer',
  version: config.APP_VERSION,
  level: config.LOG_LEVEL,
});
logger.info({ fromBlock, toBlock, count }, 'batch indexed');
```

- One JSON line per entry on stdout, with `level`, `severity` (Cloud Logging), `time` (ISO), `service`, `version`, `msg` (see `docs/09` "Logs").
- `DATABASE_URL`, `RPC_HTTP_URL` and `RPC_WS_URL` are redacted at the top level and one level down. Add new secret keys to `SECRET_KEYS`.
- Errors go under `err`. Each `cause` is a nested object, and an `AggregateError` lists `aggregateErrors`.
- NestJS apps pass `loggerOptions(...)` to nestjs-pino, so every process writes the same format.
- Locally, pipe the output into `pino-pretty` to read it. The code never pretty-prints.

## Health server

```ts
import { HealthServer } from '@gapless/observability';

const server = new HealthServer({
  live: () => true, // synchronous: liveness never waits on the database
  ready: () => checkDatabase(), // must resolve (never reject) within a short time
});
const port = await server.listen(config.METRICS_PORT); // 0 = a free port (tests)
await server.close(); // at shutdown
```

- `GET /healthz`, `GET /readyz` and, when a metrics registry is passed, `GET /metrics`; every other path or method is 404.
- Answers 200 `{"status":"ok"}` or 503 `{"status":"unavailable"}`. The bodies are fixed, so an error text (which could hold a secret) never leaves the process. A check that throws counts as 503.
- It runs on `METRICS_PORT`, which the Gateway never routes (`docs/02` "Ports"). Plain `node:http`, so it stays framework-free and probes skip the app's request pipeline.
- Each app decides what "live" and "ready" mean: the indexer in `apps/indexer/src/health/`, the API in `apps/api/src/health/`.

## Metrics

```ts
import { createMetricsRegistry, Gauge, HealthServer } from '@gapless/observability';

const registry = createMetricsRegistry(); // one per process, with the default Node.js metrics
const lag = new Gauge({ name: 'gapless_indexer_lag_blocks', help: '…', registers: [registry] });
lag.set(3);

const server = new HealthServer(checks, registry); // now also serves GET /metrics
```

- The client library is `@prometheus-io/client` (the former `prom-client`). Apps import `Counter`, `Gauge`, `Histogram` and `Registry` from this package, so the repo has one copy of the library.
- A new registry per call, never the library's global one: tests get a clean registry, and a name defined twice throws.
- `/metrics` answers in the Prometheus text format with `cache-control: no-store`. If collecting fails, it answers 500 with a fixed body; the probes keep working.
- The metric names and labels are the contract in `docs/09`. Keep label values bounded (no addresses, hashes or block numbers).
