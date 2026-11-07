import type { IncomingMessage, ServerResponse } from 'node:http';

import { Injectable, type NestMiddleware } from '@nestjs/common';

import { ApiMetrics, UNMATCHED_ROUTE } from './api-metrics.js';

/** The parts of an Express request this middleware reads. Express sets `route` on a match. */
type RoutedRequest = IncomingMessage & { readonly route?: { readonly path?: unknown } };

/**
 * The path this middleware is mounted on: every request (the same pattern as nestjs-pino). Express
 * then reports it as `req.route` of a request that no controller matched.
 */
export const ALL_ROUTES = '{/*splat}';

/** The route template of a finished request, or `unmatched` (never the raw URL, docs/09). */
export function routeLabel(req: RoutedRequest): string {
  const path = req.route?.path;
  return typeof path === 'string' && path !== ALL_ROUTES ? path : UNMATCHED_ROUTE;
}

/**
 * Records `gapless_http_requests_total` and `gapless_http_request_duration_seconds` for every
 * request on the public port, when the response closes (`close` also fires when the client goes
 * away mid-response, which `finish` does not). The route is read then, because Express matches it
 * after this middleware runs. Probes and `/metrics` are on `METRICS_PORT`, outside
 * Nest, so they are not counted.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  // Value import: Nest resolves ApiMetrics from the constructor type (docs/05).
  constructor(private readonly metrics: ApiMetrics) {}

  use(req: RoutedRequest, res: ServerResponse, next: () => void): void {
    const start = performance.now();
    res.once('close', () => {
      this.metrics.recordHttpRequest({
        method: req.method ?? 'UNKNOWN',
        route: routeLabel(req),
        statusCode: res.statusCode,
        durationSeconds: (performance.now() - start) / 1000,
      });
    });
    next();
  }
}
