import { classifyRpcError, InvalidTransferLogError } from '@gapless/chain';
import type { Hex } from 'viem';

import type { FetchedRange, FetchRangeInput } from './batch-fetcher.js';
import { afterRangeRejected, afterSuccess, initialBatchSize } from './batch-size.js';
import type { Checkpoint, CommitBatchInput, CommitBatchResult } from './indexer.repository.js';
import {
  AnchorMismatchError,
  CheckpointFenceError,
  TokenNotContractError,
} from './ingestion-errors.js';
import type { BlockHeader } from './range-consistency.js';
import { type BlockRange, planNextRange } from './range-planner.js';

/** What the loop needs from the chain. Implemented over viem in `ingestion.service.ts`. */
export type ChainPort = {
  readonly getHead: () => Promise<bigint>;
  /** The contract code at the token address (`0x` when there is none). */
  readonly getTokenCode: () => Promise<Hex>;
  /** The header of `block`, or throws `RangeInconsistentError` when the node lacks it. */
  readonly getHeader: (block: bigint) => Promise<BlockHeader>;
  readonly fetchRange: (input: Pick<FetchRangeInput, 'range' | 'anchor'>) => Promise<FetchedRange>;
};

/** What the loop needs from the database. `IndexerRepository` implements it. */
export type CheckpointStore = {
  readonly seedCheckpoint: (checkpoint: Checkpoint) => Promise<void>;
  readonly readCheckpoint: () => Promise<Checkpoint | null>;
  readonly commitBatch: (input: CommitBatchInput) => Promise<CommitBatchResult>;
};

/** The two log levels the loop uses, with pino's `(fields, message)` order. */
export type LoopLogger = {
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
};

export type LoopSettings = {
  readonly chainId: number;
  /** Lowercase, for the error message only. */
  readonly tokenAddress: string;
  readonly startBlock: bigint;
  readonly confirmations: bigint;
  readonly batchSize: bigint;
  readonly pollIntervalMs: number;
};

export type IngestionLoopDeps = {
  readonly chain: ChainPort;
  readonly store: CheckpointStore;
  readonly logger: LoopLogger;
  readonly settings: LoopSettings;
  /** Prepares an error for a log line (`redactRpcUrl`). The loop classifies the original. */
  readonly redact: (err: unknown) => unknown;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
};

/**
 * Errors that stop the indexer (docs/03 "Retry policy"): the same input fails again, or retrying
 * would break an invariant. In Phase 3 a reorg is one of them, because the rewind is Phase 4.
 */
export function isFatal(err: unknown): boolean {
  return (
    err instanceof InvalidTransferLogError ||
    err instanceof AnchorMismatchError ||
    err instanceof CheckpointFenceError ||
    err instanceof TokenNotContractError
  );
}

function blockFields(range: BlockRange | undefined): Record<string, string> {
  return range === undefined
    ? {}
    : { fromBlock: range.from.toString(), toBlock: range.to.toString() };
}

/**
 * The Phase 3 ingestion loop (docs/03 "Ingestion loop"): HTTP polling, one range at a time.
 *
 * - The checkpoint in memory is a cache of the DB row. It is replaced only by the row a commit
 *   returns, and it is read again after every failed step.
 * - A range the RPC refused because of its size halves the batch and is tried again at once.
 * - Any other non-fatal error is logged as `warn`, and the same range is tried again on the next
 *   poll. Phase 4 replaces this wait with backoff and jitter.
 * - A fatal error (`isFatal`) rejects `run`.
 */
export class IngestionLoop {
  /** Set after the first successful `eth_getCode` check of this process. */
  private tokenChecked = false;

  constructor(private readonly deps: IngestionLoopDeps) {}

  /** Runs until `signal` aborts (resolves) or a fatal error (rejects). */
  async run(signal: AbortSignal): Promise<void> {
    const { chain, store, logger, settings, redact, wait } = this.deps;
    const chainId = settings.chainId;
    let checkpoint: Checkpoint | undefined;
    let batch = initialBatchSize(settings.batchSize);

    while (!signal.aborted) {
      let range: BlockRange | undefined;
      let fetching = false;
      try {
        checkpoint ??= await this.start();
        const head = await chain.getHead();
        range =
          planNextRange({
            lastBlock: checkpoint.lastBlock,
            head,
            confirmations: settings.confirmations,
            batchSize: batch.size,
          }) ?? undefined;
        if (range === undefined) {
          await wait(settings.pollIntervalMs, signal);
          continue;
        }

        const started = performance.now();
        fetching = true;
        const fetched = await chain.fetchRange({
          range,
          anchor: { block: checkpoint.lastBlock, hash: checkpoint.lastBlockHash },
        });
        fetching = false;
        // Stop before a new transaction on shutdown. A transaction already open always finishes.
        if (signal.aborted) break;

        const result = await store.commitBatch({
          rows: fetched.rows,
          from: range.from,
          to: range.to,
          toHash: fetched.toHash,
          headBlock: head,
        });
        checkpoint = result.checkpoint;
        batch = afterSuccess(batch);
        logger.info(
          {
            chainId,
            ...blockFields(range),
            transfers: fetched.rows.length,
            inserted: result.inserted,
            batchSize: batch.size.toString(),
            durationMs: Math.round(performance.now() - started),
          },
          'batch indexed',
        );
      } catch (err) {
        if (isFatal(err)) throw err;
        // The DB may have moved or rolled back: read the checkpoint again before the next range.
        checkpoint = undefined;

        if (fetching && classifyRpcError(err) === 'range-rejected' && batch.size > 1n) {
          batch = afterRangeRejected(batch);
          logger.warn(
            { chainId, ...blockFields(range), batchSize: batch.size.toString(), err: redact(err) },
            'range rejected by the RPC, retrying with a smaller batch',
          );
          continue;
        }
        logger.warn(
          { chainId, ...blockFields(range), err: redact(err) },
          'indexing step failed, retrying on the next poll',
        );
        await wait(settings.pollIntervalMs, signal);
      }
    }
  }

  /**
   * Checks the token once per process, then reads the checkpoint, seeding it on a fresh database
   * (docs/03 "Startup"). Also runs after a failed step, so a deleted row is seeded again.
   */
  private async start(): Promise<Checkpoint> {
    const { chain, store, settings } = this.deps;
    if (!this.tokenChecked) {
      // A wallet or a token on another chain has no code, and getLogs for it returns empty lists.
      const code = await chain.getTokenCode();
      if (code === '0x') throw new TokenNotContractError(settings.tokenAddress);
      this.tokenChecked = true;
    }

    const stored = await store.readCheckpoint();
    if (stored !== null) return stored;

    const seedBlock = settings.startBlock - 1n;
    const header = await chain.getHeader(seedBlock);
    await store.seedCheckpoint({
      lastBlock: seedBlock,
      lastBlockHash: header.hash,
      headBlock: seedBlock,
    });
    const seeded = await store.readCheckpoint();
    if (seeded === null) throw new Error('The checkpoint row is missing right after the seed');
    return seeded;
  }
}
