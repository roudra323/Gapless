import { InvalidTransferLogError } from '@gapless/chain';
import type { NewTransferRow } from '@gapless/db';
import { type Hex, numberToHex, pad, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';

import type { FetchRangeInput } from './batch-fetcher.js';
import type { Checkpoint, CommitBatchInput, RewindInput } from './indexer.repository.js';
import {
  AnchorMismatchError,
  CheckpointFenceError,
  RangeInconsistentError,
  TokenNotContractError,
} from './ingestion-errors.js';
import { IndexerMetrics } from '../metrics/indexer-metrics.js';
import { type ChainPort, IngestionLoop, type LoopSettings } from './ingestion-loop.js';

function hash(n: bigint): Hex {
  return pad(numberToHex(n), { size: 32 });
}

const SETTINGS: LoopSettings = {
  chainId: 31337,
  tokenAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  startBlock: 10n,
  confirmations: 0n,
  batchSize: 8n,
  pollIntervalMs: 1000,
  reorgRewindBlocks: 4n,
};

/** A fetch failure that aborts the loop's signal first, as a lost lock connection does. */
const LOST = new Error('Client was closed and is not queryable');

type Call = { readonly kind: string; readonly from?: bigint; readonly to?: bigint };

/**
 * A chain with a fixed head and a store in memory. `failures` hands out one error per fetch, in
 * order. The loop stops itself (aborts) once the checkpoint reaches `stopAt`, or after `maxWaits`
 * waits (backoff waits and head waits both count).
 */
function setup(
  options: {
    head?: bigint;
    stopAt?: bigint;
    maxWaits?: number;
    failures?: (Error | undefined)[];
    rewindFailures?: (Error | undefined)[];
    code?: Hex;
    stored?: Checkpoint;
    /** Stored transfer blocks, for the reorg walk. */
    storedBlocks?: bigint[];
    /** Blocks whose chain hash changed (a reorg). */
    forked?: (block: bigint) => boolean;
  } = {},
) {
  const head = options.head ?? 30n;
  const stopAt = options.stopAt ?? head;
  const failures = [...(options.failures ?? [])];
  const rewindFailures = [...(options.rewindFailures ?? [])];
  const forked = options.forked ?? (() => false);
  const chainHash = (block: bigint) => (forked(block) ? hash(block + 1_000_000n) : hash(block));
  const controller = new AbortController();
  const calls: Call[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const delays: number[] = [];
  let row: Checkpoint | null = options.stored ?? null;
  let waits = 0;
  let beats = 0;
  const countWait = () => {
    waits++;
    if (waits >= (options.maxWaits ?? 1)) controller.abort();
  };

  const chain: ChainPort = {
    getTokenCode: () => {
      calls.push({ kind: 'getTokenCode' });
      return Promise.resolve(options.code ?? '0x6080');
    },
    getHeader: (block) => {
      calls.push({ kind: 'getHeader', from: block });
      return Promise.resolve({ number: block, hash: chainHash(block), timestamp: 0n });
    },
    fetchRange: ({ range, anchor }: Pick<FetchRangeInput, 'range' | 'anchor'>) => {
      calls.push({ kind: 'fetch', from: range.from, to: range.to });
      const failure = failures.shift();
      if (failure === LOST) controller.abort();
      if (failure !== undefined) return Promise.reject(failure);
      if (anchor.hash !== chainHash(anchor.block)) {
        return Promise.reject(
          new AnchorMismatchError(anchor.block, anchor.hash, chainHash(anchor.block)),
        );
      }
      const rows = [{ blockNumber: range.from } as NewTransferRow];
      return Promise.resolve({ toHash: chainHash(range.to), rows });
    },
  };

  const heads = {
    latest: () => head,
    version: () => 0,
    waitForChange: () => {
      calls.push({ kind: 'waitHead' });
      countWait();
      return Promise.resolve();
    },
  };

  const store = {
    seedCheckpoint: (checkpoint: Checkpoint) => {
      calls.push({ kind: 'seed', to: checkpoint.lastBlock });
      row ??= checkpoint;
      return Promise.resolve();
    },
    readCheckpoint: () => {
      calls.push({ kind: 'read' });
      return Promise.resolve(row);
    },
    commitBatch: (input: CommitBatchInput) => {
      calls.push({ kind: 'commit', from: input.from, to: input.to });
      if (row?.lastBlock !== input.from - 1n) {
        return Promise.reject(new CheckpointFenceError(input.from - 1n));
      }
      row = { lastBlock: input.to, lastBlockHash: input.toHash, headBlock: input.headBlock };
      if (row.lastBlock >= stopAt) controller.abort();
      return Promise.resolve({ checkpoint: row, inserted: input.rows.length });
    },
    newestTransferBlockAtOrBelow: (block: bigint) => {
      const found = (options.storedBlocks ?? []).filter((b) => b <= block).at(-1);
      return Promise.resolve(
        found === undefined ? null : { blockNumber: found, blockHash: hash(found) },
      );
    },
    rewind: (input: RewindInput) => {
      calls.push({ kind: 'rewind', to: input.rewindTo });
      const failure = rewindFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      row = { lastBlock: input.rewindTo, lastBlockHash: input.rewindHash, headBlock: head };
      return Promise.resolve({ checkpoint: row, deleted: 3 });
    },
  };

  const metrics = new IndexerMetrics();
  const loop = new IngestionLoop({
    chain,
    heads,
    store,
    metrics,
    settings: SETTINGS,
    logger: {
      info: (fields, message) => logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    },
    heartbeat: { beat: () => beats++ },
    redact: (err) => ({ redacted: String(err) }),
    wait: (ms) => {
      delays.push(ms);
      calls.push({ kind: 'wait' });
      countWait();
      return Promise.resolve();
    },
    random: () => 0.999_999,
  });

  return {
    run: () => loop.run(controller.signal),
    abort: () => controller.abort(),
    calls,
    logs,
    delays,
    beats: () => beats,
    ranges: () => calls.filter((call) => call.kind === 'fetch').map((c) => [c.from, c.to]),
    checkpoint: () => row,
    /** The whole scrape text. */
    scrape: () => metrics.registry.metrics(),
    /** The current value of one metric series. */
    metric: async (name: string, labels: Record<string, string> = {}) => {
      const values = (await metrics.registry.getSingleMetric(name)?.get())?.values ?? [];
      return values.find((value) =>
        Object.entries(labels).every(([key, label]) => value.labels[key] === label),
      )?.value;
    },
  };
}

describe('IngestionLoop', () => {
  it('seeds START_BLOCK - 1 on a fresh database, then indexes contiguous ranges', async () => {
    const t = setup({ head: 30n });
    await t.run();

    expect(t.calls.slice(0, 4).map((call) => call.kind)).toEqual([
      'getTokenCode',
      'read',
      'getHeader',
      'seed',
    ]);
    expect(t.calls.find((call) => call.kind === 'seed')?.to).toBe(9n);
    expect(t.ranges()).toEqual([
      [10n, 17n],
      [18n, 25n],
      [26n, 30n],
    ]);
    expect(t.checkpoint()).toEqual({ lastBlock: 30n, lastBlockHash: hash(30n), headBlock: 30n });
  });

  it('logs one info line per batch with the block range as strings', async () => {
    const t = setup({ head: 17n });
    await t.run();

    expect(t.logs).toEqual([
      {
        level: 'info',
        message: 'batch indexed',
        fields: expect.objectContaining({
          chainId: 31337,
          fromBlock: '10',
          toBlock: '17',
          transfers: 1,
          inserted: 1,
          batchSize: '8',
        }) as unknown,
      },
    ]);
  });

  it('continues from a stored checkpoint without seeding again', async () => {
    const t = setup({
      head: 30n,
      stored: { lastBlock: 25n, lastBlockHash: hash(25n), headBlock: 25n },
    });
    await t.run();

    expect(t.calls.some((call) => call.kind === 'seed')).toBe(false);
    expect(t.ranges()).toEqual([[26n, 30n]]);
  });

  it('waits for the next head when it is caught up', async () => {
    const t = setup({ head: 9n, stopAt: 100n, maxWaits: 2 });
    await t.run();

    expect(t.ranges()).toEqual([]);
    expect(t.calls.filter((call) => call.kind === 'waitHead')).toHaveLength(2);
  });

  it('halves the batch on a rejected range and retries the same range at once', async () => {
    const tooBig = new TimeoutError({ body: {}, url: 'http://rpc.local' });
    const t = setup({ head: 17n, failures: [tooBig, tooBig] });
    await t.run();

    expect(t.ranges()).toEqual([
      [10n, 17n],
      [10n, 13n],
      [10n, 11n],
      [12n, 13n],
      [14n, 15n],
      [16n, 17n],
    ]);
    expect(t.calls.some((call) => call.kind === 'wait')).toBe(false);
    expect(t.logs.filter((log) => log.level === 'warn').map((log) => log.fields.batchSize)).toEqual(
      ['4', '2'],
    );
  });

  it('backs off instead of halving when the batch is already 1 block', async () => {
    const tooBig = new TimeoutError({ body: {}, url: 'http://rpc.local' });
    const t = setup({ head: 10n, failures: Array.from({ length: 4 }, () => tooBig), maxWaits: 1 });
    await t.run();

    expect(t.ranges()).toEqual([
      [10n, 10n],
      [10n, 10n],
      [10n, 10n],
      [10n, 10n],
    ]);
  });

  it('on a transient error, logs warn, reads the checkpoint again and retries after backoff', async () => {
    const t = setup({
      head: 17n,
      failures: [new RangeInconsistentError('node is behind')],
      maxWaits: 5,
    });
    await t.run();

    const kinds = t.calls.map((call) => call.kind);
    const failedAt = kinds.indexOf('fetch');
    expect(kinds.slice(failedAt, failedAt + 4)).toEqual(['fetch', 'wait', 'getTokenCode', 'read']);
    expect(t.ranges()).toEqual([
      [10n, 17n],
      [10n, 17n],
    ]);
    const warn = t.logs.find((log) => log.level === 'warn');
    expect(warn?.message).toBe('indexing step failed, retrying after backoff');
    expect(warn?.fields).toMatchObject({
      fromBlock: '10',
      toBlock: '17',
      attempt: 0,
      delayMs: 499,
    });
    // The loop logs the redacted copy, never the original error.
    expect(warn?.fields.err).toEqual({
      redacted: expect.stringContaining('node is behind') as unknown,
    });
  });

  it('grows the backoff on each failed step and resets it after a commit', async () => {
    const down = new Error('connect ECONNREFUSED');
    const t = setup({ head: 17n, stopAt: 25n, failures: [down, down, down], maxWaits: 10 });
    await t.run();

    // random() is ~1, so each delay is the backoff ceiling: 500, 1000, 2000 ms.
    expect(t.delays).toEqual([499, 999, 1999]);
    const attempts = t.logs.filter((l) => l.level === 'warn').map((l) => l.fields.attempt);
    expect(attempts).toEqual([0, 1, 2]);
    expect(t.checkpoint()?.lastBlock).toBe(17n);
  });

  it('starts the backoff again at attempt 0 after a success', async () => {
    const down = new Error('connect ECONNREFUSED');
    const t = setup({ head: 30n, failures: [down, undefined, down], maxWaits: 10 });
    await t.run();
    expect(t.logs.filter((l) => l.level === 'warn').map((l) => l.fields.attempt)).toEqual([0, 0]);
  });

  it('beats the heartbeat on every cycle, also on every retry', async () => {
    const down = new Error('connect ECONNREFUSED');
    const t = setup({ head: 9n, failures: [], maxWaits: 3 });
    await t.run();
    expect(t.beats()).toBe(3);

    const retries = setup({ head: 10n, failures: [down, down, down, down], maxWaits: 4 });
    await retries.run();
    // One beat per attempt: 4 failed fetches, each one a cycle.
    expect(retries.beats()).toBe(4);
  });

  it('rewinds on a reorg to a proven block and indexes again from there', async () => {
    // The checkpoint is at 20 with the old hash of 20; blocks above 14 changed on the chain.
    const t = setup({
      head: 24n,
      stored: { lastBlock: 20n, lastBlockHash: hash(20n), headBlock: 20n },
      storedBlocks: [11n, 14n, 18n],
      forked: (block) => block > 14n,
    });
    await t.run();

    // candidate = 20 - 4 = 16 → row 14 matches the chain → rewind to 14.
    expect(t.calls.find((call) => call.kind === 'rewind')?.to).toBe(14n);
    expect(t.ranges()).toEqual([
      [21n, 24n],
      [15n, 22n],
      [23n, 24n],
    ]);
    const warn = t.logs.find((log) => log.message === 'reorg detected, rewinding');
    expect(warn?.fields).toMatchObject({ block: '20', rewindTo: '14', deleted: 3 });
    // A reorg is not a failure: no backoff wait.
    expect(t.delays).toEqual([]);
  });

  it('treats a failed rewind as transient: it backs off and tries again', async () => {
    const t = setup({
      head: 24n,
      stored: { lastBlock: 20n, lastBlockHash: hash(20n), headBlock: 20n },
      storedBlocks: [14n],
      forked: (block) => block > 14n,
      rewindFailures: [new Error('connection terminated')],
      maxWaits: 5,
    });
    await t.run();

    expect(t.calls.filter((call) => call.kind === 'rewind')).toHaveLength(2);
    expect(t.delays).toHaveLength(1);
    expect(t.checkpoint()?.lastBlock).toBe(24n);
  });

  it('stops without a warning when the signal aborts during a step (lost leadership)', async () => {
    const t = setup({ head: 17n, failures: [LOST] });
    await t.run();
    expect(t.logs.filter((log) => log.level === 'warn')).toEqual([]);
    expect(t.delays).toEqual([]);
  });

  it.each([
    ['an invalid Transfer log', new InvalidTransferLogError('4 topics')],
    ['a fence miss', new CheckpointFenceError(9n)],
  ])('stops on %s', async (_label, fatal) => {
    const t = setup({ head: 17n, failures: [fatal] });
    await expect(t.run()).rejects.toBe(fatal);
    expect(t.calls.some((call) => call.kind === 'commit')).toBe(false);
  });

  it('stops when the token address holds no code', async () => {
    const t = setup({ code: '0x' });
    await expect(t.run()).rejects.toBeInstanceOf(TokenNotContractError);
    expect(t.calls.some((call) => call.kind === 'seed')).toBe(false);
  });

  it('checks the token code at every start, also with a stored checkpoint', async () => {
    const t = setup({
      code: '0x',
      stored: { lastBlock: 25n, lastBlockHash: hash(25n), headBlock: 25n },
    });
    await expect(t.run()).rejects.toBeInstanceOf(TokenNotContractError);
  });

  it('does not start when the signal is already aborted', async () => {
    const t = setup();
    const controller = new AbortController();
    controller.abort();
    const loop = new IngestionLoop({
      chain: {} as ChainPort,
      heads: { latest: () => 1n, version: () => 0, waitForChange: () => Promise.resolve() },
      store: {
        seedCheckpoint: () => Promise.reject(new Error('used')),
        readCheckpoint: () => Promise.reject(new Error('used')),
        commitBatch: () => Promise.reject(new Error('used')),
        newestTransferBlockAtOrBelow: () => Promise.reject(new Error('used')),
        rewind: () => Promise.reject(new Error('used')),
      },
      settings: SETTINGS,
      metrics: new IndexerMetrics(),
      logger: { info: () => undefined, warn: () => undefined },
      heartbeat: { beat: () => undefined },
      redact: (err) => err,
      wait: () => Promise.resolve(),
    });
    await loop.run(controller.signal);
    expect(t.calls).toEqual([]);
  });

  describe('metrics', () => {
    const ok = { result: 'ok' };
    const error = { result: 'error' };

    it('records each committed batch, the rows, the time, the checkpoint and the batch size', async () => {
      const t = setup({ head: 30n });
      await t.run();

      // Three ranges (10–17, 18–25, 26–30), one row each in this fake chain.
      expect(await t.metric('gapless_indexer_batches_total', ok)).toBe(3);
      expect(await t.metric('gapless_indexer_batches_total', error)).toBe(0);
      expect(await t.metric('gapless_indexer_events_indexed_total')).toBe(3);
      expect(await t.metric('gapless_indexer_processed_block')).toBe(30);
      expect(await t.metric('gapless_indexer_batch_size_blocks')).toBe(8);
      expect(await t.scrape()).toContain('gapless_indexer_batch_duration_seconds_count 3');
    });

    it('counts a rejected range as a failed batch and shows the smaller batch size', async () => {
      const tooBig = new TimeoutError({ body: {}, url: 'http://rpc.local' });
      const t = setup({ head: 17n, failures: [tooBig, tooBig] });
      await t.run();

      expect(await t.metric('gapless_indexer_batches_total', error)).toBe(2);
      expect(await t.metric('gapless_indexer_batches_total', ok)).toBe(4);
      expect(await t.metric('gapless_indexer_batch_size_blocks')).toBe(2);
    });

    it('counts a transient error as a failed batch', async () => {
      const t = setup({
        head: 17n,
        failures: [new RangeInconsistentError('node is behind')],
        maxWaits: 5,
      });
      await t.run();
      expect(await t.metric('gapless_indexer_batches_total', error)).toBe(1);
      expect(await t.metric('gapless_indexer_batches_total', ok)).toBe(1);
    });

    it('counts a reorg once, and shows the rewound checkpoint before indexing again', async () => {
      const t = setup({
        head: 24n,
        stored: { lastBlock: 20n, lastBlockHash: hash(20n), headBlock: 20n },
        storedBlocks: [11n, 14n, 18n],
        forked: (block) => block > 14n,
      });
      await t.run();

      expect(await t.metric('gapless_indexer_reorgs_total')).toBe(1);
      // The range 21–24 found the reorg; 15–22 and 23–24 committed.
      expect(await t.metric('gapless_indexer_batches_total', error)).toBe(1);
      expect(await t.metric('gapless_indexer_batches_total', ok)).toBe(2);
      expect(await t.metric('gapless_indexer_processed_block')).toBe(24);
    });

    it('does not count a lost lock or a shutdown as a failed batch', async () => {
      const t = setup({ head: 17n, failures: [LOST] });
      await t.run();
      expect(await t.metric('gapless_indexer_batches_total', error)).toBe(0);
      expect(await t.metric('gapless_indexer_batches_total', ok)).toBe(0);
    });
  });
});
