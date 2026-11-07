import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiMetrics, statusClass } from './api-metrics.js';

type DocumentedMetric = { readonly type: string; readonly labels: readonly string[] };

/** The rows of the "API metrics" table in docs/09: name → type and labels. */
function documentedMetrics(): Map<string, DocumentedMetric> {
  const doc = readFileSync(
    join(import.meta.dirname, '../../../../docs/09-observability.md'),
    'utf8',
  );
  const section = doc.split('### API metrics')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map<string, DocumentedMetric>();
  for (const line of section.split('\n')) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const name = /^`(gapless_[a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!name) continue;
    // "`method`, `route`, `status_class` (`2xx`/…)" → ["method", "route", "status_class"].
    const labels = (cells[3] ?? '')
      .split(', ')
      .map((part) => /^`([a-z_]+)`/.exec(part)?.[1])
      .filter((label) => label !== undefined);
    rows.set(name, { type: cells[2] ?? '', labels });
  }
  return rows;
}

describe('ApiMetrics', () => {
  it('defines exactly the metrics in the docs/09 table, with the same types and labels', async () => {
    const documented = documentedMetrics();
    expect(documented.size).toBe(3);

    const metrics = new ApiMetrics();
    const defined = new Map<string, DocumentedMetric>();
    for (const metric of await metrics.registry.getMetricsAsJSON()) {
      if (!metric.name.startsWith('gapless_')) continue;
      const labelNames = (
        metrics.registry.getSingleMetric(metric.name) as unknown as {
          labelNames: readonly string[];
        }
      ).labelNames;
      defined.set(metric.name, { type: String(metric.type), labels: [...labelNames] });
    }
    expect(defined).toEqual(documented);
  });

  it('serves the default process metrics too', async () => {
    expect(await new ApiMetrics().registry.metrics()).toContain('process_cpu_user_seconds_total');
  });

  it('counts a request by method, route and status class, and times it', async () => {
    const metrics = new ApiMetrics();
    metrics.recordHttpRequest({
      method: 'GET',
      route: '/v1/stats',
      statusCode: 200,
      durationSeconds: 0.02,
    });
    metrics.recordHttpRequest({
      method: 'GET',
      route: '/v1/stats',
      statusCode: 503,
      durationSeconds: 0.1,
    });
    metrics.recordHttpRequest({
      method: 'GET',
      route: 'unmatched',
      statusCode: 404,
      durationSeconds: 0.001,
    });

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'gapless_http_requests_total{method="GET",route="/v1/stats",status_class="2xx"} 1',
    );
    expect(text).toContain(
      'gapless_http_requests_total{method="GET",route="/v1/stats",status_class="5xx"} 1',
    );
    expect(text).toContain(
      'gapless_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1',
    );
    expect(text).toContain(
      'gapless_http_request_duration_seconds_count{method="GET",route="/v1/stats"} 2',
    );
  });

  it('times a query, also when it fails, and passes the result through', async () => {
    const metrics = new ApiMetrics();
    expect(await metrics.timeQuery('stats', () => Promise.resolve(7))).toBe(7);
    const boom = new Error('db down');
    await expect(metrics.timeQuery('stats', () => Promise.reject(boom))).rejects.toBe(boom);

    expect(await metrics.registry.metrics()).toContain(
      'gapless_db_query_duration_seconds_count{query="stats"} 2',
    );
  });

  it.each([
    [200, '2xx'],
    [304, '3xx'],
    [404, '4xx'],
    [503, '5xx'],
  ])('maps status %i to %s', (code, label) => {
    expect(statusClass(code)).toBe(label);
  });
});
