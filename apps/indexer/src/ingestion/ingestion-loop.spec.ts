import { InvalidTransferLogError } from '@gapless/chain';
import type { NewTransferRow } from '@gapless/db';
import { type Hex, numberToHex, pad, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';

import type { FetchRangeInput } from './batch-fetcher.js';
import type { Checkpoint, CommitBatchInput } from './indexer.repository.js';
import {
  AnchorMismatchError,
  CheckpointFenceError,
  RangeInconsistentError,
  TokenNotContractError,
} from './ingestion-errors.js';
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
};

type Call = { readonly kind: string; readonly from?: bigint; readonly to?: bigint };

/**
 * A chain with a fixed head and a store in memory. `failures` hands out one error per fetch, in
 * order. The loop stops itself (aborts) once the checkpoint reaches `stopAt`, or after `maxWaits`.
 */
function setup(
  options: {
    head?: bigint;
    stopAt?: bigint;
    maxWaits?: number;
    failures?: (Error | undefined)[];
    code?: Hex;
    stored?: Checkpoint;
  } = {},
) {
  const head = options.head ?? 30n;
  const stopAt = options.stopAt ?? head;
  const failures = [...(options.failures ?? [])];
  const controller = new AbortController();
  const calls: Call[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  let row: Checkpoint | null = options.stored ?? null;
  let waits = 0;

  const chain: ChainPort = {
    getHead: () => Promise.resolve(head),
    getTokenCode: () => {
      calls.push({ kind: 'getTokenCode' });
      return Promise.resolve(options.code ?? '0x6080');
    },
    getHeader: (block) => {
      calls.push({ kind: 'getHeader', from: block });
      return Promise.resolve({ number: block, hash: hash(block), timestamp: 0n });
    },
    fetchRange: ({ range, anchor }: Pick<FetchRangeInput, 'range' | 'anchor'>) => {
      calls.push({ kind: 'fetch', from: range.from, to: range.to });
      const failure = failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (anchor.hash !== hash(anchor.block)) throw new Error('test bug: wrong anchor');
      const rows = [{ blockNumber: range.from } as NewTransferRow];
      return Promise.resolve({ toHash: hash(range.to), rows });
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
  };

  const loop = new IngestionLoop({
    chain,
    store,
    settings: SETTINGS,
    logger: {
      info: (fields, message) => logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    },
    redact: (err) => ({ redacted: String(err) }),
    wait: () => {
      waits++;
      calls.push({ kind: 'wait' });
      if (waits >= (options.maxWaits ?? 1)) controller.abort();
      return Promise.resolve();
    },
  });

  return {
    run: () => loop.run(controller.signal),
    calls,
    logs,
    ranges: () => calls.filter((call) => call.kind === 'fetch').map((c) => [c.from, c.to]),
    checkpoint: () => row,
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

  it('waits for the next poll when it is caught up', async () => {
    const t = setup({ head: 9n, stopAt: 100n, maxWaits: 2 });
    await t.run();

    expect(t.ranges()).toEqual([]);
    expect(t.calls.filter((call) => call.kind === 'wait')).toHaveLength(2);
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

  it('waits instead of halving when the batch is already 1 block', async () => {
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

  it('on a transient error, logs warn, reads the checkpoint again and retries after a poll', async () => {
    const t = setup({
      head: 17n,
      failures: [new RangeInconsistentError('node is behind')],
      maxWaits: 5,
    });
    await t.run();

    const kinds = t.calls.map((call) => call.kind);
    const failedAt = kinds.indexOf('fetch');
    expect(kinds.slice(failedAt, failedAt + 3)).toEqual(['fetch', 'wait', 'read']);
    expect(t.ranges()).toEqual([
      [10n, 17n],
      [10n, 17n],
    ]);
    const warn = t.logs.find((log) => log.level === 'warn');
    expect(warn?.message).toBe('indexing step failed, retrying on the next poll');
    expect(warn?.fields).toMatchObject({ fromBlock: '10', toBlock: '17' });
    // The loop logs the redacted copy, never the original error.
    expect(warn?.fields.err).toEqual({
      redacted: expect.stringContaining('node is behind') as unknown,
    });
  });

  it.each([
    ['an invalid Transfer log', new InvalidTransferLogError('4 topics')],
    ['a reorg (the rewind is Phase 4)', new AnchorMismatchError(9n, hash(9n), hash(99n))],
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
      store: {
        seedCheckpoint: () => Promise.reject(new Error('used')),
        readCheckpoint: () => Promise.reject(new Error('used')),
        commitBatch: () => Promise.reject(new Error('used')),
      },
      settings: SETTINGS,
      logger: { info: () => undefined, warn: () => undefined },
      redact: (err) => err,
      wait: () => Promise.resolve(),
    });
    await loop.run(controller.signal);
    expect(t.calls).toEqual([]);
  });
});
