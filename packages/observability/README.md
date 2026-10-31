# `packages/observability` — `@gapless/observability`

prom-client registry helpers and pino logger config. Framework-free.

- **Built in:** Phase 3 (pino logger config), Phase 6 (metrics)
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
