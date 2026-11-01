import { classifyRpcError, InvalidTransferLogError } from '@gapless/chain';
import type { Hex } from 'viem';

import { backoffDelay } from './backoff.js';
import type { FetchedRange, FetchRangeInput } from './batch-fetcher.js';
import { afterRangeRejected, afterSuccess, initialBatchSize } from './batch-size.js';
import type {
  Checkpoint,
  CommitBatchInput,
  CommitBatchResult,
  RewindInput,
  RewindResult,
} from './indexer.repository.js';
import {
  AnchorMismatchError,
  CheckpointFenceError,
  TokenNotContractError,
} from './ingestion-errors.js';
import type { BlockHeader } from './range-consistency.js';
import { type BlockRange, planNextRange } from './range-planner.js';
import { findRewindTarget, type StoredBlock } from './reorg.js';

/** What the loop needs from the chain over HTTP. Implemented over viem in `ingestion.service.ts`. */
export type ChainPort = {
  /** The contract code at the token address (`0x` when there is none). */
  readonly getTokenCode: () => Promise<Hex>;
  /** The header of `block`, or throws `RangeInconsistentError` when the node lacks it. */
  readonly getHeader: (block: bigint) => Promise<BlockHeader>;
  readonly fetchRange: (input: Pick<FetchRangeInput, 'range' | 'anchor'>) => Promise<FetchedRange>;
};

/** The chain head and its change signal. `HeadTracker` implements it. */
export type HeadSource = {
  readonly latest: () => bigint | undefined;
  readonly version: () => number;
  readonly waitForChange: (
    signal: AbortSignal,
    timeoutMs: number,
    sinceVersion?: number,
  ) => Promise<void>;
};

/** What the loop needs from the database. `IndexerRepository` implements it. */
export type CheckpointStore = {
  readonly seedCheckpoint: (checkpoint: Checkpoint) => Promise<void>;
  readonly readCheckpoint: () => Promise<Checkpoint | null>;
  readonly commitBatch: (input: CommitBatchInput) => Promise<CommitBatchResult>;
  readonly newestTransferBlockAtOrBelow: (block: bigint) => Promise<StoredBlock | null>;
  readonly rewind: (input: RewindInput) => Promise<RewindResult>;
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
  readonly reorgRewindBlocks: bigint;
};

export type IngestionLoopDeps = {
  readonly chain: ChainPort;
  readonly heads: HeadSource;
  readonly store: CheckpointStore;
  readonly logger: LoopLogger;
  readonly settings: LoopSettings;
  /** The liveness heartbeat (docs/03 "Health"): beaten on every cycle and every retry. */
  readonly heartbeat: { readonly beat: () => void };
  /** Prepares an error for a log line (`redactRpcUrl`). The loop classifies the original. */
  readonly redact: (err: unknown) => unknown;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** For the backoff jitter. Tests pass a fixed value. */
  readonly random?: () => number;
};

/**
 * Errors that stop the indexer (docs/03 "Retry policy"): the same input fails again, or retrying
 * would break an invariant. The process exits non-zero, so Kubernetes restarts it and the alert
 * shows the problem.
 */
export function isFatal(err: unknown): boolean {
  return (
    err instanceof InvalidTransferLogError ||
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
 * The ingestion loop for one leadership term (docs/03 "Ingestion loop"). It must run on a store
 * bound to the advisory-lock connection, and `signal` aborts on shutdown or when the lock is lost.
 *
 * - The checkpoint in memory is a cache of the DB row. It is replaced only by the row a commit or
 *   a rewind returns, and it is read again after every failed step.
 * - When it has caught up, it waits for the next head (the WebSocket doorbell or the poll).
 * - A range the RPC refused because of its size halves the batch and is tried again at once.
 * - An anchor mismatch is a reorg: it runs the proven rewind and continues.
 * - Any other non-fatal error is retried after `backoffDelay`, forever.
 * - A fatal error (`isFatal`) rejects `run`.
 */
export class IngestionLoop {
  constructor(private readonly deps: IngestionLoopDeps) {}

  /** Runs until `signal` aborts (resolves) or a fatal error (rejects). */
  async run(signal: AbortSignal): Promise<void> {
    const { chain, heads, store, logger, settings, heartbeat, redact, wait, random } = this.deps;
    const chainId = settings.chainId;
    let checkpoint: Checkpoint | undefined;
    let batch = initialBatchSize(settings.batchSize);
    let attempt = 0;

    while (!signal.aborted) {
      heartbeat.beat();
      let range: BlockRange | undefined;
      let fetching = false;
      try {
        checkpoint ??= await this.start();
        const seen = heads.version();
        const head = heads.latest();
        range =
          head === undefined
            ? undefined
            : (planNextRange({
                lastBlock: checkpoint.lastBlock,
                head,
                confirmations: settings.confirmations,
                batchSize: batch.size,
              }) ?? undefined);
        if (range === undefined || head === undefined) {
          attempt = 0;
          await heads.waitForChange(signal, settings.pollIntervalMs, seen);
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
        attempt = 0;
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
      } catch (caught) {
        let err = caught;
        if (isFatal(err)) throw err;
        // Lost leadership or shutdown: the supervisor logs it. Nothing was committed.
        if (signal.aborted) return;

        if (err instanceof AnchorMismatchError && checkpoint !== undefined) {
          try {
            checkpoint = await this.rewind(checkpoint, err);
            attempt = 0;
            continue;
          } catch (rewindErr) {
            if (isFatal(rewindErr)) throw rewindErr;
            if (signal.aborted) return;
            err = rewindErr;
          }
        }
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
        const delayMs = backoffDelay(attempt, random);
        logger.warn(
          { chainId, ...blockFields(range), attempt, delayMs, err: redact(err) },
          'indexing step failed, retrying after backoff',
        );
        attempt += 1;
        await wait(delayMs, signal);
      }
    }
  }

  /**
   * Checks the token, then reads the checkpoint, seeding it on a fresh database (docs/03
   * "Startup"). Runs at the start of every leadership term and after every failed step, so a
   * deleted row is seeded again.
   */
  private async start(): Promise<Checkpoint> {
    const { chain, store, settings } = this.deps;
    // A wallet or a token on another chain has no code, and getLogs for it returns empty lists.
    const code = await chain.getTokenCode();
    if (code === '0x') throw new TokenNotContractError(settings.tokenAddress);

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

  /** The proven rewind after a reorg (docs/03 "Reorg guard"). Returns the rewound checkpoint. */
  private async rewind(checkpoint: Checkpoint, mismatch: AnchorMismatchError): Promise<Checkpoint> {
    const { chain, store, settings, logger } = this.deps;
    const target = await findRewindTarget({
      lastBlock: checkpoint.lastBlock,
      rewindBlocks: settings.reorgRewindBlocks,
      startBlock: settings.startBlock,
      newestStoredAtOrBelow: (block) => store.newestTransferBlockAtOrBelow(block),
      chainHashOf: async (block) => (await chain.getHeader(block)).hash,
    });
    const result = await store.rewind({ ...target, expectedLastBlock: checkpoint.lastBlock });
    logger.warn(
      {
        chainId: settings.chainId,
        block: mismatch.block.toString(),
        storedHash: mismatch.storedHash,
        chainHash: mismatch.chainHash,
        rewindTo: target.rewindTo.toString(),
        deleted: result.deleted,
      },
      'reorg detected, rewinding',
    );
    return result.checkpoint;
  }
}
