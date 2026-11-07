import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IndexerMetrics } from './indexer-metrics.js';

type DocumentedMetric = { readonly type: string; readonly labels: readonly string[] };

/** The rows of the "Indexer metrics" table in docs/09: name → type and labels. */
function documentedMetrics(): Map<string, DocumentedMetric> {
  const doc = readFileSync(
    join(import.meta.dirname, '../../../../docs/09-observability.md'),
    'utf8',
  );
  const section = doc.split('### Indexer metrics')[1]?.split('\n### ')[0] ?? '';
  const rows = new Map<string, DocumentedMetric>();
  for (const line of section.split('\n')) {
    // Split on the column pipes only: a cell can hold an escaped `\|` ("`ok`\|`error`").
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const name = /^`(gapless_[a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!name) continue;
    // "`method`, `transport` = `http`\|`ws`" → ["method", "transport"]; "—" → [].
    // Each comma-separated part starts with its label name.
    const labels = (cells[3] ?? '')
      .split(', ')
      .map((part) => /^`([a-z_]+)`/.exec(part)?.[1])
      .filter((label) => label !== undefined);
    rows.set(name, { type: cells[2] ?? '', labels });
  }
  return rows;
}

describe('IndexerMetrics', () => {
  it('defines exactly the metrics in the docs/09 table, with the same types and labels', async () => {
    const documented = documentedMetrics();
    expect(documented.size).toBe(14); // proves the table was parsed

    const { registry } = new IndexerMetrics();
    const ours = (await registry.getMetricsAsJSON()).filter((metric) =>
      metric.name.startsWith('gapless_'),
    );
    expect(ours.map((metric) => metric.name).toSorted()).toEqual([...documented.keys()].toSorted());

    for (const [name, doc] of documented) {
      expect(ours.find((metric) => metric.name === name)?.type, name).toBe(doc.type);
      // The label names are on the metric object, not in its JSON form.
      const metric = registry.getSingleMetric(name) as { labelNames?: string[] } | undefined;
      expect((metric?.labelNames ?? []).toSorted(), name).toEqual(doc.labels.toSorted());
    }
  });

  it('serves its metrics and the default process metrics on the scrape', async () => {
    const text = await new IndexerMetrics().registry.metrics();
    expect(text).toContain('# TYPE gapless_indexer_lag_blocks gauge');
    expect(text).toContain('# TYPE gapless_indexer_batch_duration_seconds histogram');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('starts the batch outcomes at 0, so the first error is a visible increase', async () => {
    const text = await new IndexerMetrics().registry.metrics();
    expect(text).toContain('gapless_indexer_batches_total{result="ok"} 0');
    expect(text).toContain('gapless_indexer_batches_total{result="error"} 0');
  });

  it('gives each instance its own registry, so app instances never share values', async () => {
    const first = new IndexerMetrics();
    const second = new IndexerMetrics();
    first.reorgs.inc();
    expect(await first.registry.metrics()).toContain('gapless_indexer_reorgs_total 1');
    expect(await second.registry.metrics()).toContain('gapless_indexer_reorgs_total 0');
  });
});
