import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type HealthChecks = {
  /** Liveness (`/healthz`): synchronous, so a busy database can't make it fail. */
  readonly live: () => boolean;
  /** Readiness (`/readyz`). Must resolve (never reject) within a short time. */
  readonly ready: () => Promise<boolean>;
};

/**
 * The internal health endpoints on `METRICS_PORT` (docs/02 "Ports", docs/03 "Health"), on
 * `node:http` with no framework. Phase 6 adds `GET /metrics` to the same server.
 *
 * The bodies are fixed (`{"status":"ok"}` or `{"status":"unavailable"}`): an error text could
 * hold a secret, and a probe only reads the status code.
 */
export class HealthServer {
  private readonly server: Server;

  constructor(private readonly checks: HealthChecks) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Starts listening. Returns the bound port (useful with port 0). */
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
}

function send(res: ServerResponse, status: number, body: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
