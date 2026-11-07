import type { ApiConfig } from '@gapless/config';
import type { DbHandle } from '@gapless/db';
import { HealthServer } from '@gapless/observability';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { API_CONFIG } from '../config.provider.js';
import { DB_HANDLE } from '../database/database.tokens.js';
import { ApiMetrics } from '../metrics/api-metrics.js';
import { isDatabaseReachable } from './database-check.js';

/**
 * `/healthz`, `/readyz` and `/metrics` on `METRICS_PORT` for the whole process life (docs/02
 * "Ports", docs/09 "Metrics"), with the shared `HealthServer`.
 *
 * - Live: always true. The server answers only while the event loop runs, which is the point of
 *   a liveness probe. It never depends on the database, so a DB outage does not restart pods.
 * - Ready: the database answers `select 1` within 2 s, and the process is not shutting down.
 */
@Injectable()
export class HealthService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly server: HealthServer;
  private shuttingDown = false;
  private boundPort: number | undefined;

  // Value import of PinoLogger: Nest resolves it from the constructor type (docs/05).
  constructor(
    private readonly logger: PinoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    metrics: ApiMetrics,
  ) {
    logger.setContext(HealthService.name);
    this.server = new HealthServer(
      {
        live: () => true,
        ready: async () => !this.shuttingDown && (await isDatabaseReachable(this.db.pool)),
      },
      metrics.registry,
    );
  }

  /** The bound port, after boot (tests listen on port 0). */
  port(): number | undefined {
    return this.boundPort;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.boundPort = await this.server.listen(this.config.METRICS_PORT);
    this.logger.info({ port: this.boundPort }, 'health server listening');
  }

  /**
   * Runs before Nest closes the HTTP server. `/readyz` turns 503 at once, so Kubernetes stops
   * sending new requests to this pod while the open ones finish.
   */
  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server.close();
  }
}
