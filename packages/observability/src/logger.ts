import { pino, type DestinationStream, type Level, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export type LoggerConfig = {
  /** Which process is logging: `api`, `indexer`, or `migrate`. */
  readonly service: string;
  /** The deployed version (the Git SHA in Kubernetes, `dev` locally). */
  readonly version: string;
  /** Minimum level to write. */
  readonly level: Level;
};

/** Pino level → Cloud Logging `severity`, so GCP can filter by severity (see docs/09 "Logs"). */
const GCP_SEVERITY: Record<Level, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Keys that hold secrets, at the top level or one level down (for example `{ config }`).
 * Pino paths can't match a prefix such as `RPC_*`, so each key is listed.
 */
const SECRET_KEYS = ['DATABASE_URL', 'RPC_HTTP_URL', 'RPC_WS_URL'];
const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
];

/**
 * Pino options shared by every process. Exported separately so the NestJS apps can pass the
 * same options to nestjs-pino.
 */
export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    // Replaces pino's default `pid` and `hostname`; Kubernetes adds pod metadata itself.
    base: { service: config.service, version: config.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label, severity: GCP_SEVERITY[label as Level] ?? 'DEFAULT' }),
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Writes each `cause` as a nested object, with the inner errors of an AggregateError at every
    // level. The default `err` serializer joins cause messages into one string and drops the inner
    // errors of a cause, which hides the reason when connecting to `localhost` fails (IPv4 and IPv6).
    serializers: { err: pino.stdSerializers.errWithCause },
  };
}

/** Creates a JSON logger that writes one line per entry to stdout (or to `destination` in tests). */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(config), destination) : pino(loggerOptions(config));
}
