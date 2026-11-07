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

/** The value of a metric without labels. */
async function value(metrics: IndexerMetrics, name: string): Promise<number | undefined> {
  return (await metrics.registry.getSingleMetric(name)?.get())?.values[0]?.value;
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

  describe('record methods', () => {
    it('keeps the lag equal to head minus processed, whichever value changes', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordHead(100n);
      // A standby sees heads but has no checkpoint: no lag to report.
      expect(await value(metrics, 'gapless_indexer_lag_blocks')).toBe(0);

      metrics.recordCheckpoint(90n);
      expect(await value(metrics, 'gapless_indexer_lag_blocks')).toBe(10);
      metrics.recordHead(105n);
      expect(await value(metrics, 'gapless_indexer_lag_blocks')).toBe(15);
      metrics.recordCheckpoint(105n);
      expect(await value(metrics, 'gapless_indexer_lag_blocks')).toBe(0);
      expect(await value(metrics, 'gapless_indexer_head_block')).toBe(105);
      expect(await value(metrics, 'gapless_indexer_processed_block')).toBe(105);
    });

    it('never reports a negative lag', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordCheckpoint(50n);
      metrics.recordHead(40n);
      expect(await value(metrics, 'gapless_indexer_lag_blocks')).toBe(0);
    });

    it('reports the leader flag as 1 or 0, and the tick in seconds', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordLeader(true);
      expect(await value(metrics, 'gapless_indexer_is_leader')).toBe(1);
      metrics.recordLeader(false);
      expect(await value(metrics, 'gapless_indexer_is_leader')).toBe(0);
      metrics.recordTick(1_762_600_000_500);
      expect(await value(metrics, 'gapless_indexer_last_tick_timestamp_seconds')).toBe(
        1_762_600_000.5,
      );
    });

    it('reports the WS feed as 1 or 0 and counts reconnects', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordWsConnected(true);
      expect(await value(metrics, 'gapless_indexer_ws_connected')).toBe(1);
      metrics.recordWsConnected(false);
      expect(await value(metrics, 'gapless_indexer_ws_connected')).toBe(0);
      metrics.recordWsReconnect();
      metrics.recordWsReconnect();
      expect(await value(metrics, 'gapless_indexer_ws_reconnects_total')).toBe(2);
    });

    it('counts each RPC call by method, transport and result, and times it', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordRpcCall({
        method: 'eth_getLogs',
        transport: 'http',
        result: 'ok',
        durationSeconds: 0.02,
      });
      metrics.recordRpcCall({
        method: 'eth_getLogs',
        transport: 'http',
        result: 'rate_limited',
        durationSeconds: 0.01,
      });
      metrics.recordRpcCall({
        method: 'eth_subscribe',
        transport: 'ws',
        result: 'error',
        durationSeconds: 0.5,
      });

      const requests = await metrics.rpcRequests.get();
      expect(requests.values.map(({ labels, value: count }) => ({ ...labels, count }))).toEqual(
        expect.arrayContaining([
          { method: 'eth_getLogs', transport: 'http', result: 'ok', count: 1 },
          { method: 'eth_getLogs', transport: 'http', result: 'rate_limited', count: 1 },
          { method: 'eth_subscribe', transport: 'ws', result: 'error', count: 1 },
        ]),
      );
      const durations = await metrics.rpcDuration.get();
      const count = (method: string) =>
        durations.values.find(
          (sample) =>
            sample.metricName === 'gapless_rpc_request_duration_seconds_count' &&
            (sample.labels as Record<string, unknown>).method === method,
        )?.value;
      expect(count('eth_getLogs')).toBe(2);
      expect(count('eth_subscribe')).toBe(1);
    });

    it('keeps a block number up to 2^53 - 1 exact', async () => {
      const metrics = new IndexerMetrics();
      metrics.recordHead(9_007_199_254_740_991n); // Number.MAX_SAFE_INTEGER
      expect(await value(metrics, 'gapless_indexer_head_block')).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});
