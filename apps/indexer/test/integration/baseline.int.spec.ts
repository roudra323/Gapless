import 'reflect-metadata';

import { normalizeAddress } from '@gapless/chain';
import type { IndexerConfig } from '@gapless/config';
import { createRpcClient } from '@gapless/chain';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { HealthService } from '../../src/health/health.service.js';
import { IndexerRepository } from '../../src/ingestion/indexer.repository.js';
import { IngestionService } from '../../src/ingestion/ingestion.service.js';
import { verifyRange } from '../../src/verify/verify-range.js';
import { ANVIL_CHAIN_ID, startAnvil, type TestAnvil } from './harness/anvil.js';
import { startPostgres, type TestPostgres } from './harness/postgres.js';
import { deployMockToken, seededRandom, type TestToken } from './harness/token.js';
import { scrape } from './harness/metrics.js';
import { waitFor } from './harness/wait-for.js';

const CONFIRMATIONS = 2n;
type LogLine = Record<string, unknown>;

let pg: TestPostgres;
let anvil: TestAnvil;
let token: TestToken;
let config: IndexerConfig;
let repository: IndexerRepository;
const random = seededRandom(42);

// nestjs-pino keeps one root logger per module graph, and its first destination wins, so every
// app in this file writes to this one stream (see src/app.module.spec.ts).
const lines: LogLine[] = [];
const stream = { write: (line: string) => lines.push(JSON.parse(line) as LogLine) };

type RunningIndexer = { readonly app: INestApplicationContext; readonly done: Promise<void> };

/** Boots the indexer in-process, as main.ts does, and starts the loop. */
async function startIndexer(): Promise<RunningIndexer> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, stream), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  return { app, done: app.get(IngestionService).run() };
}

/** Closes the app, which stops the loop between steps; the loop must end without an error. */
async function stopIndexer({ app, done }: RunningIndexer): Promise<void> {
  await app.close();
  await done;
}

async function waitForCheckpoint(block: bigint): Promise<void> {
  await waitFor(async () => ((await repository.readCheckpoint())?.lastBlock ?? 0n) >= block, {
    timeoutMs: 60_000,
    description: `checkpoint at block ${block}`,
  });
}

async function parity() {
  const checkpoint = await repository.readCheckpoint();
  if (checkpoint === null) throw new Error('no checkpoint');
  return verifyRange({
    client: createRpcClient({ url: anvil.rpcUrl }),
    store: repository,
    tokenAddress: config.TOKEN_ADDRESS,
    from: config.START_BLOCK,
    to: checkpoint.lastBlock,
    chunkSize: 1000n,
  });
}

beforeAll(async () => {
  [pg, anvil] = await Promise.all([startPostgres(), startAnvil()]);
  token = await deployMockToken(anvil.rpcUrl);
  config = {
    DATABASE_URL: pg.url,
    LOG_LEVEL: 'info',
    APP_VERSION: 'test-sha',
    CHAIN_ID: ANVIL_CHAIN_ID,
    TOKEN_ADDRESS: normalizeAddress(token.address),
    RPC_HTTP_URL: anvil.rpcUrl,
    START_BLOCK: token.startBlock,
    CONFIRMATIONS,
    // Small, so the run takes many batches and crosses many range boundaries.
    BATCH_SIZE: 5n,
    POLL_INTERVAL_MS: 100,
    BLOCK_TIME_MS: 12_000,
    REORG_REWIND_BLOCKS: 64n,
    SHUTDOWN_TIMEOUT_MS: 20_000,
    METRICS_PORT: 0,
  };
  repository = new IndexerRepository(pg.handle.db, config.CHAIN_ID, config.TOKEN_ADDRESS);
});

afterAll(async () => {
  await Promise.all([pg?.stop(), anvil?.stop()]);
});

describe('baseline: index 500 transfers', () => {
  it('reaches exact parity with the chain, also for transfers sent while it runs', async () => {
    await token.sendTransfers(300, { perBlockMax: 12, random });

    const indexer = await startIndexer();
    const last = await token.sendTransfers(200, { perBlockMax: 12, random });
    await token.mine(Number(CONFIRMATIONS));
    await waitForCheckpoint(last);

    const report = await parity();
    expect(report).toMatchObject({ ok: true, missing: [], unexpected: [], duplicates: [] });
    expect(report.chainCount).toBe(501); // the mint + 500 transfers
    expect(report.dbCount).toBe(501);

    // Only confirmed blocks: the checkpoint never passes head - CONFIRMATIONS.
    const head = await token.publicClient.getBlockNumber();
    const checkpoint = await repository.readCheckpoint();
    expect(checkpoint?.lastBlock).toBeLessThanOrEqual(head - CONFIRMATIONS);

    // The metrics tell the same story as the database (docs/09 "Indexer metrics").
    const metrics = await scrape(`http://127.0.0.1:${indexer.app.get(HealthService).port()}`);
    const processed = metrics.get('gapless_indexer_processed_block');
    const headSeen = metrics.get('gapless_indexer_head_block') ?? 0;
    expect(processed).toBe(Number(checkpoint?.lastBlock));
    expect(headSeen).toBeGreaterThanOrEqual(processed ?? Infinity);
    expect(metrics.get('gapless_indexer_lag_blocks')).toBe(headSeen - (processed ?? 0));
    expect(metrics.get('gapless_indexer_events_indexed_total')).toBe(501);
    expect(metrics.get('gapless_indexer_batches_total{result="ok"}')).toBeGreaterThan(10);
    expect(metrics.get('gapless_indexer_batches_total{result="error"}')).toBe(0);
    expect(metrics.get('gapless_indexer_batch_duration_seconds_count')).toBe(
      metrics.get('gapless_indexer_batches_total{result="ok"}'),
    );
    expect(metrics.get('gapless_indexer_batch_size_blocks')).toBeGreaterThan(0);
    expect(metrics.get('gapless_indexer_is_leader')).toBe(1);
    expect(metrics.get('gapless_indexer_reorgs_total')).toBe(0);
    const tickAgeSeconds =
      Date.now() / 1000 - (metrics.get('gapless_indexer_last_tick_timestamp_seconds') ?? 0);
    expect(tickAgeSeconds).toBeLessThan(10);
    // RPC calls over HTTP, all fine; no WebSocket in this run.
    expect(metrics.sum('gapless_rpc_requests_total', { transport: 'http', result: 'ok' })).toBe(
      metrics.sum('gapless_rpc_request_duration_seconds_count'),
    );
    expect(
      metrics.sum('gapless_rpc_requests_total', { method: 'eth_getLogs', result: 'ok' }),
    ).toBeGreaterThan(10);
    expect(metrics.sum('gapless_rpc_requests_total', { result: 'error' })).toBe(0);
    expect(metrics.get('gapless_indexer_ws_connected')).toBe(0);
    expect(metrics.get('gapless_indexer_ws_reconnects_total')).toBe(0);

    await stopIndexer(indexer);
  });

  it('continues from the checkpoint after a restart, with no duplicates', async () => {
    const before = await repository.readCheckpoint();
    if (before === null) throw new Error('no checkpoint');
    const firstBatchOfRestart = lines.length;

    const last = await token.sendTransfers(20, { perBlockMax: 12, random });
    await token.mine(Number(CONFIRMATIONS));
    const indexer = await startIndexer();
    await waitForCheckpoint(last);
    await stopIndexer(indexer);

    const restartBatches = lines
      .slice(firstBatchOfRestart)
      .filter((l) => l.msg === 'batch indexed');
    expect(restartBatches[0]?.fromBlock).toBe((before.lastBlock + 1n).toString());

    const report = await parity();
    expect(report).toMatchObject({ ok: true, chainCount: 521, dbCount: 521 });
  });

  it('logs JSON with the required fields and no secrets', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatchObject({
        level: expect.any(String) as unknown,
        severity: expect.any(String) as unknown,
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
        service: 'indexer',
        version: 'test-sha',
        msg: expect.any(String) as unknown,
      });
    }

    const batches = lines.filter((line) => line.msg === 'batch indexed');
    expect(batches.length).toBeGreaterThan(10);
    for (const batch of batches) {
      expect(batch).toMatchObject({
        level: 'info',
        chainId: ANVIL_CHAIN_ID,
        fromBlock: expect.stringMatching(/^\d+$/) as unknown,
        toBlock: expect.stringMatching(/^\d+$/) as unknown,
      });
    }
    expect(batches.reduce((sum, batch) => sum + Number(batch.inserted), 0)).toBe(521);

    const text = JSON.stringify(lines);
    expect(text).not.toContain(pg.url);
    // The container's password is "test", which "test-sha" contains, so check the URL scheme.
    expect(text).not.toContain('postgres://');
  });
});
