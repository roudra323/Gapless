import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { MetricsSource } from './metrics.js';

/** The two checks a process gives to {@link HealthServer}. */
export type HealthChecks = {
  /** Liveness (`/healthz`): synchronous, so a busy database can't make it fail. */
  readonly live: () => boolean;
  /** Readiness (`/readyz`). Must resolve (never reject) within a short time. */
  readonly ready: () => Promise<boolean>;
};

/**
 * The internal endpoints on `METRICS_PORT` (docs/02 "Ports", docs/03 "Health", docs/09
 * "Metrics"), on `node:http` with no framework: `/healthz`, `/readyz` and, when a metrics source
 * is given, `/metrics`. The indexer and the API both use it, so their probes and scrapes behave
 * the same.
 *
 * The health bodies are fixed (`{"status":"ok"}` or `{"status":"unavailable"}`): an error text
 * could hold a secret, and a probe only reads the status code.
 */
export class HealthServer {
  private readonly server: Server;

  /**
   * @param checks liveness and readiness.
   * @param metrics the process's metrics registry. Without it, `/metrics` is 404.
   */
  constructor(
    private readonly checks: HealthChecks,
    private readonly metrics?: MetricsSource,
  ) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /**
   * Starts listening. Returns the bound port (useful with port 0).
   *
   * @throws the `listen` error, for example `EADDRINUSE` when the port is taken.
   */
  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    return (this.server.address() as AddressInfo).port;
  }

  /** Stops listening and closes open connections. Safe to call when not listening. */
  async close(): Promise<void> {
    if (!this.server.listening) return;
    // Probes are short requests. Don't let a kept-alive socket hold the shutdown.
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/metrics' && this.metrics) {
      await this.sendMetrics(res, this.metrics);
      return;
    }
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/readyz')) {
      send(res, 404, { status: 'not found' });
      return;
    }
    let ok: boolean;
    try {
      ok = path === '/healthz' ? this.checks.live() : await this.checks.ready();
    } catch {
      ok = false;
    }
    send(res, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable' });
  }

  private async sendMetrics(res: ServerResponse, source: MetricsSource): Promise<void> {
    let body: string;
    try {
      body = await source.metrics();
    } catch {
      // A failed collect is a 500 for this scrape only; Prometheus marks the scrape failed
      // (`up == 0`) and tries again at the next interval. Fixed body, as for the probes.
      send(res, 500, { status: 'metrics unavailable' });
      return;
    }
    res.writeHead(200, { 'content-type': source.contentType, 'cache-control': 'no-store' });
    res.end(body);
  }
}

function send(res: ServerResponse, status: number, body: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
