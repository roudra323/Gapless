import { collectDefaultMetrics, Registry } from '@prometheus-io/client';

// The metric classes, from this package only: the apps then use one copy and one version of the
// client library (docs/09 "Metrics").
export { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

/** What {@link HealthServer} needs to serve `GET /metrics`. A {@link Registry} matches it. */
export type MetricsSource = {
  /** The `Content-Type` of the scrape body (the Prometheus text format). */
  readonly contentType: string;
  /** The scrape body: every metric of the process, in the text format. */
  readonly metrics: () => Promise<string>;
};

/**
 * The one metrics registry of a process, with the default process and Node.js runtime metrics
 * (CPU, memory, event loop lag, GC, ...). Create it once at boot and pass it to the code that
 * defines the app's metrics and to the health server.
 *
 * A new registry instead of the library's global one: tests can create a fresh registry each
 * time, and a metric name defined twice throws at once instead of mixing two processes' metrics.
 */
export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}
