import 'reflect-metadata';

import { createRpcClient, normalizeAddress } from '@gapless/chain';
import type { IndexerConfig } from '@gapless/config';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { AppModule } from '../../../src/app.module.js';
import { HealthService } from '../../../src/health/health.service.js';
import { IndexerRepository } from '../../../src/ingestion/indexer.repository.js';
import { IngestionService } from '../../../src/ingestion/ingestion.service.js';
import { type ParityReport, verifyRange } from '../../../src/verify/verify-range.js';
import { ANVIL_CHAIN_ID, startAnvil, type TestAnvil } from './anvil.js';
import { startPostgres, type TestPostgres } from './postgres.js';
import { deployMockToken, type TestToken } from './token.js';
import { waitFor } from './wait-for.js';

/** A Postgres, an anvil chain with MockToken, and helpers. One per test file. */
export type World = {
  readonly pg: TestPostgres;
  readonly anvil: TestAnvil;
  readonly token: TestToken;
  readonly repository: IndexerRepository;
  /** A config for this world: CONFIRMATIONS=2, BATCH_SIZE=10, a 100 ms poll, port 0. */
  readonly config: (overrides?: Partial<IndexerConfig>) => IndexerConfig;
  /** Parity from START_BLOCK to the stored checkpoint (docs/06 "parity assertion"). */
  readonly parity: () => Promise<ParityReport>;
  /** Waits until the checkpoint is at `block` or above. */
  readonly waitForCheckpoint: (block: bigint, timeoutMs?: number) => Promise<void>;
  /**
   * Creates the first checkpoint the way the indexer does (START_BLOCK - 1 and its hash), so a
   * test can lock the row before the indexer's first batch.
   */
  readonly seedCheckpoint: () => Promise<void>;
  /** The transfer rows above the checkpoint. Atomic progress means this is always 0. */
  readonly rowsAboveCheckpoint: () => Promise<number>;
  readonly stop: () => Promise<void>;
};

export async function startWorld(): Promise<World> {
  const [pg, anvil] = await Promise.all([startPostgres(), startAnvil()]);
  const token = await deployMockToken(anvil.rpcUrl);
  const tokenAddress = normalizeAddress(token.address);
  const repository = new IndexerRepository(pg.handle.db, ANVIL_CHAIN_ID, tokenAddress);

  const config = (overrides: Partial<IndexerConfig> = {}): IndexerConfig => ({
    DATABASE_URL: pg.url,
    LOG_LEVEL: 'info',
    APP_VERSION: 'chaos',
    CHAIN_ID: ANVIL_CHAIN_ID,
    TOKEN_ADDRESS: tokenAddress,
    RPC_HTTP_URL: anvil.rpcUrl,
    START_BLOCK: token.startBlock,
    CONFIRMATIONS: 2n,
    BATCH_SIZE: 10n,
    POLL_INTERVAL_MS: 100,
    REORG_REWIND_BLOCKS: 64n,
    SHUTDOWN_TIMEOUT_MS: 20_000,
    METRICS_PORT: 0,
    ...overrides,
  });

  const checkpointBlock = async () => (await repository.readCheckpoint())?.lastBlock;

  return {
    pg,
    anvil,
    token,
    repository,
    config,
    parity: async () => {
      const to = await checkpointBlock();
      if (to === undefined) throw new Error('no checkpoint');
      return verifyRange({
        client: createRpcClient({ url: anvil.rpcUrl }),
        store: repository,
        tokenAddress,
        from: token.startBlock,
        to,
        chunkSize: 1000n,
      });
    },
    waitForCheckpoint: async (block, timeoutMs = 60_000) => {
      await waitFor(async () => ((await checkpointBlock()) ?? 0n) >= block, {
        timeoutMs,
        description: `checkpoint at block ${block}`,
      });
    },
    seedCheckpoint: async () => {
      const seed = token.startBlock - 1n;
      const block = await token.publicClient.getBlock({ blockNumber: seed });
      await repository.seedCheckpoint({
        lastBlock: seed,
        lastBlockHash: block.hash,
        headBlock: seed,
      });
    },
    rowsAboveCheckpoint: async () => {
      const result = await pg.handle.db.execute<{ n: number }>(sql`
        select count(*)::int as n from transfers t
        join indexer_checkpoints c
          on c.chain_id = t.chain_id and c.token_address = t.token_address
        where t.block_number > c.last_block`);
      return result.rows[0]?.n ?? 0;
    },
    stop: async () => {
      await Promise.all([pg.stop(), anvil.stop()]);
    },
  };
}

export type LogLine = Record<string, unknown>;

/**
 * A pino destination that keeps every line as parsed JSON. nestjs-pino keeps one root logger per
 * module graph and its first destination wins, so a test file uses one capture for all its apps.
 */
export function captureLogs(): { lines: LogLine[]; stream: DestinationStream } {
  const lines: LogLine[] = [];
  return { lines, stream: { write: (line: string) => lines.push(JSON.parse(line) as LogLine) } };
}

export type InProcessIndexer = {
  readonly app: INestApplicationContext;
  /** The `run()` promise: resolves on a clean stop, rejects on a fatal error. */
  readonly done: Promise<void>;
  /** The health server's base URL. */
  readonly healthUrl: string;
  readonly stop: () => Promise<void>;
};

/** Boots the indexer in this process, as main.ts does, and starts it. */
export async function startInProcess(
  config: IndexerConfig,
  stream: DestinationStream,
): Promise<InProcessIndexer> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, stream), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  const done = app.get(IngestionService).run();
  // A rejection is checked by the test through `done`; never leave it unhandled meanwhile.
  done.catch(() => undefined);
  const port = app.get(HealthService).port();
  return {
    app,
    done,
    healthUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await app.close();
      await done;
    },
  };
}
