import { setTimeout as delay } from 'node:timers/promises';

import type { IndexerConfig } from '@gapless/config';
import type { DbHandle } from '@gapless/db';
import { HealthServer } from '@gapless/observability';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { INDEXER_CONFIG } from '../config.provider.js';
import { DB_HANDLE } from '../ingestion/ingestion.providers.js';
import { LeaderStatus } from '../leader/leader-status.js';
import { isLive, isReady } from './health-status.js';
import { Heartbeat } from './heartbeat.js';

/** A readiness probe must answer fast; a database slower than this counts as unreachable. */
export const DB_CHECK_TIMEOUT_MS = 2000;

/** Runs the health server for the whole process life (docs/03 "Health"). */
@Injectable()
export class HealthService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly server: HealthServer;
  private boundPort: number | undefined;

  // Value imports: Nest resolves these from the constructor types (docs/05).
  constructor(
    private readonly logger: PinoLogger,
    @Inject(INDEXER_CONFIG) private readonly config: IndexerConfig,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly heartbeat: Heartbeat,
    private readonly leader: LeaderStatus,
  ) {
    logger.setContext(HealthService.name);
    this.server = new HealthServer({
      live: () => isLive(this.heartbeat.lastBeatAt(), Date.now(), this.config.POLL_INTERVAL_MS),
      ready: () => this.ready(),
    });
  }

  /** The bound port, after boot (tests listen on port 0). */
  port(): number | undefined {
    return this.boundPort;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.boundPort = await this.server.listen(this.config.METRICS_PORT);
    this.logger.info({ port: this.boundPort }, 'health server listening');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server.close();
  }

  private async ready(): Promise<boolean> {
    // A standby never needs the DB check: it is not ready anyway.
    if (!this.leader.isLeader()) return false;
    const abort = new AbortController();
    const dbReachable = await Promise.race([
      this.db.pool.query('select 1').then(
        () => true,
        () => false,
      ),
      delay(DB_CHECK_TIMEOUT_MS, false, { signal: abort.signal }).catch(() => false),
    ]);
    abort.abort();
    return isReady({ isLeader: this.leader.isLeader(), dbReachable });
  }
}
