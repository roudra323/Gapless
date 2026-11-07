import { afterEach, describe, expect, it } from 'vitest';

import { type HealthChecks, HealthServer } from './health-server.js';
import type { MetricsSource } from './metrics.js';

let server: HealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(checks: HealthChecks, metrics?: MetricsSource): Promise<string> {
  server = new HealthServer(checks, metrics);
  const port = await server.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${port}`;
}

describe('HealthServer', () => {
  it('answers 200 on both endpoints when live and ready', async () => {
    const base = await start({ live: () => true, ready: () => Promise.resolve(true) });

    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('answers 503 when not live or not ready', async () => {
    const base = await start({ live: () => false, ready: () => Promise.resolve(false) });

    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    const readyz = await fetch(`${base}/readyz`);
    expect(readyz.status).toBe(503);
    expect(await readyz.json()).toEqual({ status: 'unavailable' });
  });

  it('answers 503 with a fixed body when a check throws, and never shows the error', async () => {
    const base = await start({
      live: () => {
        throw new Error('postgres://user:hunter2@db');
      },
      ready: () => Promise.reject(new Error('postgres://user:hunter2@db')),
    });

    for (const path of ['/healthz', '/readyz']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('hunter2');
    }
  });

  it('keeps liveness apart from readiness', async () => {
    // For example, an indexer standby (not the leader) is live but not ready: it must not be
    // restarted.
    const base = await start({ live: () => true, ready: () => Promise.resolve(false) });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it('answers 404 for other paths and methods, and for /metrics without a source', async () => {
    const base = await start({ live: () => true, ready: () => Promise.resolve(true) });
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
  });

  it('ignores the query string', async () => {
    const base = await start({ live: () => true, ready: () => Promise.resolve(true) });
    expect((await fetch(`${base}/healthz?probe=1`)).status).toBe(200);
  });

  describe('/metrics', () => {
    const LIVE = { live: () => true, ready: () => Promise.resolve(true) };

    it('serves the source body with its content type', async () => {
      const source: MetricsSource = {
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        metrics: () => Promise.resolve('gapless_test_total 1\n'),
      };
      const base = await start(LIVE, source);

      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('gapless_test_total 1\n');
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    });

    it('answers 500 with a fixed body when collecting fails, and keeps serving probes', async () => {
      const base = await start(LIVE, {
        contentType: 'text/plain',
        metrics: () => Promise.reject(new Error('postgres://user:hunter2@db')),
      });

      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('hunter2');
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  });
});
