import { describe, expect, it } from 'vitest';

import { Counter, createMetricsRegistry } from './metrics.js';

describe('createMetricsRegistry', () => {
  it('has the default process and Node.js metrics', async () => {
    const text = await createMetricsRegistry().metrics();
    expect(text).toContain('# TYPE process_cpu_user_seconds_total counter');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
    expect(text).toContain('nodejs_heap_size_used_bytes');
  });

  it('serves a metric defined on it, in the Prometheus text format', async () => {
    const registry = createMetricsRegistry();
    const counter = new Counter({
      name: 'gapless_test_things_total',
      help: 'Things counted by the test.',
      registers: [registry],
    });
    counter.inc();
    counter.inc(2);

    expect(registry.contentType).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await registry.metrics();
    expect(text).toContain('# HELP gapless_test_things_total Things counted by the test.');
    expect(text).toContain('# TYPE gapless_test_things_total counter');
    expect(text).toContain('gapless_test_things_total 3');
  });

  it('gives each call its own registry', async () => {
    const first = createMetricsRegistry();
    const second = createMetricsRegistry();
    const counter = new Counter({
      name: 'gapless_test_only_first_total',
      help: 'x',
      registers: [first],
    });
    counter.inc();
    expect(await second.metrics()).not.toContain('gapless_test_only_first_total');
  });

  it('throws when a metric name is defined twice on one registry', () => {
    const registry = createMetricsRegistry();
    const define = () =>
      new Counter({ name: 'gapless_test_twice_total', help: 'x', registers: [registry] });
    define();
    expect(define).toThrow(/already been registered/);
  });
});
