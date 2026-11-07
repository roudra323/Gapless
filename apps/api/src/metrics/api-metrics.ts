import { Counter, createMetricsRegistry, Histogram, type Registry } from '@gapless/observability';

/**
 * Request time. The `ApiLatencyHigh` alert is at a p95 of 0.5 s (docs/09), so the buckets are
 * fine around it.
 */
export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** One query. An indexed page read takes a few ms; the top buckets catch a slow or busy DB. */
export const DB_QUERY_DURATION_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];

/** The `route` label of a request that matched no route (a 404). Keeps the label set bounded. */
export const UNMATCHED_ROUTE = 'unmatched';

/** The `query` label: one fixed name per repository read (docs/09 "API metrics"). */
export type DbQueryName = 'recent_transfers' | 'address_transfers' | 'stats';

/** One finished HTTP request on the public port. */
export type HttpRequestSample = {
  readonly method: string;
  /** The route template (`/v1/addresses/:address/transfers`) or {@link UNMATCHED_ROUTE}. */
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
};

/** `200` → `2xx`. */
export function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

/**
 * Every metric of the API process, on one registry (docs/09 "API metrics" is the contract;
 * `api-metrics.spec.ts` checks the code against that table). The same shape as the indexer's
 * `IndexerMetrics`: the names, labels and buckets live here, and the code calls `record*` and
 * `timeQuery`.
 */
export class ApiMetrics {
  readonly registry: Registry;

  readonly httpRequests: Counter<'method' | 'route' | 'status_class'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly dbQueryDuration: Histogram<'query'>;

  /** @param registry a fresh registry by default; tests can pass their own. */
  constructor(registry: Registry = createMetricsRegistry()) {
    this.registry = registry;
    const registers = [registry];

    this.httpRequests = new Counter({
      name: 'gapless_http_requests_total',
      help: 'HTTP requests on the public port by method, route template and status class.',
      labelNames: ['method', 'route', 'status_class'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'gapless_http_request_duration_seconds',
      help: 'HTTP request time by method and route template.',
      labelNames: ['method', 'route'],
      buckets: HTTP_DURATION_BUCKETS,
      registers,
    });
    this.dbQueryDuration = new Histogram({
      name: 'gapless_db_query_duration_seconds',
      help: 'Database read time by query name.',
      labelNames: ['query'],
      buckets: DB_QUERY_DURATION_BUCKETS,
      registers,
    });
  }

  recordHttpRequest({ method, route, statusCode, durationSeconds }: HttpRequestSample): void {
    this.httpRequests.inc({ method, route, status_class: statusClass(statusCode) });
    this.httpDuration.observe({ method, route }, durationSeconds);
  }

  /** Runs one read and records its time, also when it fails. The result passes through. */
  async timeQuery<T>(query: DbQueryName, run: () => Promise<T>): Promise<T> {
    const end = this.dbQueryDuration.startTimer({ query });
    try {
      return await run();
    } finally {
      end();
    }
  }
}
