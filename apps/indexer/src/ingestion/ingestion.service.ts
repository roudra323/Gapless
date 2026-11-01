import { setTimeout as delay } from 'node:timers/promises';

import { redactRpcUrl } from '@gapless/chain';
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
import { fetchRange } from './batch-fetcher.js';
import { IndexerRepository } from './indexer.repository.js';
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
 * Connects the ingestion loop to viem and Postgres and owns its lifetime. `main.ts` calls `run`
 * after boot. On shutdown the loop is stopped between steps, then the pool is closed.
 */
@Injectable()
export class IngestionService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  // PinoLogger is a value import: Nest resolves it from the constructor type (docs/05).
  constructor(
    private readonly logger: PinoLogger,
    @Inject(INDEXER_CONFIG) private readonly config: IndexerConfig,
    @Inject(RPC_CLIENT) private readonly client: PublicClient,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
  ) {
    logger.setContext(IngestionService.name);
  }

  /** Runs the loop until shutdown (resolves) or a fatal error (rejects). Call it once. */
  run(): Promise<void> {
    if (this.running !== undefined) throw new Error('IngestionService.run was already called');
    const { config, client } = this;
    const tokenAddress = config.TOKEN_ADDRESS;
    const loop = new IngestionLoop({
      chain: {
        getHead: () => client.getBlockNumber(),
        getTokenCode: () =>
          client.request({ method: 'eth_getCode', params: [tokenAddress, 'latest'] }),
        getHeader: async (block) =>
          toBlockHeader(
            await client.request({
              method: 'eth_getBlockByNumber',
              params: [numberToHex(block), false],
            }),
            block,
          ),
        fetchRange: (input) =>
          fetchRange(client, { ...input, chainId: config.CHAIN_ID, tokenAddress }),
      },
      store: new IndexerRepository(this.db.db, config.CHAIN_ID, tokenAddress),
      logger: {
        info: (fields, message) => this.logger.info(fields, message),
        warn: (fields, message) => this.logger.warn(fields, message),
      },
      settings: {
        chainId: config.CHAIN_ID,
        tokenAddress,
        startBlock: config.START_BLOCK,
        confirmations: config.CONFIRMATIONS,
        batchSize: config.BATCH_SIZE,
        pollIntervalMs: config.POLL_INTERVAL_MS,
      },
      redact: (err) => redactRpcUrl(err, config.RPC_HTTP_URL),
      wait,
    });
    this.running = loop.run(this.abort.signal);
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
}
