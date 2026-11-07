import { setTimeout as delay } from 'node:timers/promises';

import { redactRpcUrl, subscribeNewHeads } from '@gapless/chain';
import type { IndexerConfig } from '@gapless/config';
import type { DbHandle } from '@gapless/db';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { numberToHex, type PublicClient } from 'viem';

import { INDEXER_CONFIG } from '../config.provider.js';
import { HeadTracker } from '../head/head-tracker.js';
import { Heartbeat } from '../health/heartbeat.js';
import { LeaderLock } from '../leader/leader-lock.js';
import { LeaderStatus } from '../leader/leader-status.js';
import { advisoryLockKey } from '../leader/lock-key.js';
import { IndexerMetrics } from '../metrics/indexer-metrics.js';
import { fetchRange } from './batch-fetcher.js';
import { IndexerRepository } from './indexer.repository.js';
import { IndexerSupervisor } from './indexer-supervisor.js';
import { DB_HANDLE, RPC_CLIENT } from './ingestion.providers.js';
import { IngestionLoop } from './ingestion-loop.js';
import { toBlockHeader } from './range-consistency.js';

/** Resolves after `ms`, or at once when `signal` aborts. */
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (err) {
    // The abort is the expected way out of the wait on shutdown, not a failure.
    if (!signal.aborted) throw err;
  }
}

/**
 * Connects the indexer's parts and owns their lifetime: the head tracker (HTTP poll + optional
 * WebSocket), the advisory lock, and the ingestion loop that runs while this process leads.
 * `main.ts` calls `run` after boot. On shutdown the loop stops between steps, the lock is
 * released, the socket is closed, and then the pool is closed.
 */
@Injectable()
export class IngestionService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  // Value imports: Nest resolves these from the constructor types (docs/05).
  constructor(
    private readonly logger: PinoLogger,
    @Inject(INDEXER_CONFIG) private readonly config: IndexerConfig,
    @Inject(RPC_CLIENT) private readonly client: PublicClient,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly heartbeat: Heartbeat,
    private readonly leaderStatus: LeaderStatus,
    private readonly metrics: IndexerMetrics,
  ) {
    logger.setContext(IngestionService.name);
  }

  /** Runs until shutdown (resolves) or a fatal error (rejects). Call it once. */
  run(): Promise<void> {
    if (this.running !== undefined) throw new Error('IngestionService.run was already called');
    this.running = this.runAll();
    return this.running;
  }

  /** Stops the loop and waits for it, so no transaction is open when the pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    // A rejection is handled by whoever called `run` (main.ts logs it as fatal).
    await this.running?.catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }

  private async runAll(): Promise<void> {
    const { config, client, logger } = this;
    const tokenAddress = config.TOKEN_ADDRESS;
    const wsUrl = config.RPC_WS_URL;
    // viem errors carry the request URL, which may hold an API key: hide both RPC URLs.
    const redact = (err: unknown) =>
      redactRpcUrl(redactRpcUrl(err, config.RPC_HTTP_URL), wsUrl ?? '');
    const log = {
      info: (fields: Record<string, unknown>, message: string) => logger.info(fields, message),
      warn: (fields: Record<string, unknown>, message: string) => logger.warn(fields, message),
    };

    const heads = new HeadTracker({
      sources: {
        pollHead: () => client.getBlockNumber(),
        subscribeHeads:
          wsUrl === undefined
            ? undefined
            : (handlers) =>
                subscribeNewHeads({
                  url: wsUrl,
                  ...handlers,
                  onCall: (call) => this.metrics.recordRpcCall(call),
                }),
      },
      pollIntervalMs: config.POLL_INTERVAL_MS,
      logger: log,
      redact,
      wait,
      // docs/03 "HeadTracker": the socket is stalled after 3 block times behind the poll.
      wsStallAfterMs: 3 * config.BLOCK_TIME_MS,
      onHeadChange: (head) => this.metrics.recordHead(head),
      onWsConnected: (connected) => this.metrics.recordWsConnected(connected),
      onWsReconnect: () => this.metrics.recordWsReconnect(),
    });

    const getHeader = async (block: bigint) =>
      toBlockHeader(
        await client.request({
          method: 'eth_getBlockByNumber',
          params: [numberToHex(block), false],
        }),
        block,
      );

    const supervisor = new IndexerSupervisor({
      lock: new LeaderLock(this.db.pool, advisoryLockKey(config.CHAIN_ID, tokenAddress), log),
      createLoop: (session) =>
        new IngestionLoop({
          chain: {
            getTokenCode: () =>
              client.request({ method: 'eth_getCode', params: [tokenAddress, 'latest'] }),
            getHeader,
            fetchRange: (input) =>
              fetchRange(client, { ...input, chainId: config.CHAIN_ID, tokenAddress }),
          },
          heads,
          // Every write runs in the session that holds the lock (docs/03 "Leader").
          store: new IndexerRepository(session.db, config.CHAIN_ID, tokenAddress),
          logger: log,
          metrics: this.metrics,
          settings: {
            chainId: config.CHAIN_ID,
            tokenAddress,
            startBlock: config.START_BLOCK,
            confirmations: config.CONFIRMATIONS,
            batchSize: config.BATCH_SIZE,
            pollIntervalMs: config.POLL_INTERVAL_MS,
            reorgRewindBlocks: config.REORG_REWIND_BLOCKS,
          },
          heartbeat: this.heartbeat,
          redact,
          wait,
        }),
      heartbeat: this.heartbeat,
      leaderStatus: this.leaderStatus,
      logger: log,
      wait,
    });

    heads.start();
    try {
      await supervisor.run(this.abort.signal);
    } finally {
      await heads.stop();
    }
  }
}
