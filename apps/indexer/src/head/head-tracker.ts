import { backoffDelay } from '../ingestion/backoff.js';

/** A live head subscription. `close` is awaited before the next subscribe. */
export type HeadSubscription = {
  readonly close: () => Promise<void>;
};

export type HeadSubscribeHandlers = {
  readonly onHead: (block: bigint) => void;
  /** Called once when the subscription dies after it was set up. */
  readonly onError: (err: unknown) => void;
};

export type HeadSources = {
  /** The chain head over HTTP (`eth_blockNumber`). */
  readonly pollHead: () => Promise<bigint>;
  /** The WebSocket `newHeads` subscription, or `undefined` in poll-only mode (no `RPC_WS_URL`). */
  readonly subscribeHeads?: (handlers: HeadSubscribeHandlers) => Promise<HeadSubscription>;
};

export type HeadTrackerLogger = {
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
};

export type HeadTrackerDeps = {
  readonly sources: HeadSources;
  readonly pollIntervalMs: number;
  readonly logger: HeadTrackerLogger;
  /** Prepares an error for a log line (`redactRpcUrl` for both RPC URLs). */
  readonly redact: (err: unknown) => unknown;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  /** Called on every head change, from either source (the `head_block` gauge, docs/09). */
  readonly onHeadChange?: (head: bigint) => void;
};

/**
 * Keeps the latest chain head and wakes the ingestion loop when it changes (docs/03
 * "HeadTracker"). It never carries event data: the loop always reads logs over HTTP from the
 * checkpoint, so a lost socket can't cause a gap.
 *
 * - The **poll source** reads the head every `pollIntervalMs`. It always runs, even while the
 *   WebSocket is healthy, so progress never depends on the socket.
 * - The **WS source** (only with `RPC_WS_URL`) gets each new head at once. When the socket dies,
 *   it subscribes again after `backoffDelay`, forever.
 */
export class HeadTracker {
  private head: bigint | undefined;
  /** Increases on every head change, so a waiter can't miss a change that came before it. */
  private changes = 0;
  private readonly waiters = new Set<() => void>();
  private readonly stopController = new AbortController();
  private running: Promise<void>[] = [];

  constructor(private readonly deps: HeadTrackerDeps) {}

  /** The latest head seen, or `undefined` before the first one. */
  latest(): bigint | undefined {
    return this.head;
  }

  /** A counter of head changes. Pass it to `waitForChange` to wait for a change after it. */
  version(): number {
    return this.changes;
  }

  /**
   * Resolves when the head changes after `sinceVersion` (at once if it already did), after
   * `timeoutMs`, or when `signal` aborts. Never rejects.
   */
  waitForChange(
    signal: AbortSignal,
    timeoutMs: number,
    sinceVersion = this.changes,
  ): Promise<void> {
    if (this.changes !== sinceVersion || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal.addEventListener('abort', done, { once: true });
      this.waiters.add(done);
    });
  }

  /** Starts both sources. Call it once. */
  start(): void {
    const signal = this.stopController.signal;
    this.running = [this.pollForever(signal)];
    if (this.deps.sources.subscribeHeads !== undefined) {
      this.running.push(this.subscribeForever(this.deps.sources.subscribeHeads, signal));
    }
  }

  /** Stops both sources, closes the socket, and wakes every waiter. */
  async stop(): Promise<void> {
    this.stopController.abort();
    // Each wake removes itself from the set; deleting the current entry is safe during for…of.
    for (const wake of this.waiters) wake();
    await Promise.all(this.running);
  }

  private update(block: bigint): void {
    if (block === this.head) return;
    this.head = block;
    this.changes += 1;
    this.deps.onHeadChange?.(block);
    // Each wake removes itself from the set; deleting the current entry is safe during for…of.
    for (const wake of this.waiters) wake();
  }

  private async pollForever(signal: AbortSignal): Promise<void> {
    const { sources, pollIntervalMs, logger, redact, wait } = this.deps;
    let failing = false;
    while (!signal.aborted) {
      try {
        this.update(await sources.pollHead());
        if (failing) logger.info({}, 'head poll recovered');
        failing = false;
      } catch (err) {
        // One line per outage, not one per poll: the ingestion loop already logs each retry.
        if (!failing) logger.warn({ err: redact(err) }, 'head poll failed');
        failing = true;
      }
      await wait(pollIntervalMs, signal);
    }
  }

  private async subscribeForever(
    subscribe: NonNullable<HeadSources['subscribeHeads']>,
    signal: AbortSignal,
  ): Promise<void> {
    const { logger, redact, wait, random } = this.deps;
    let attempt = 0;
    while (!signal.aborted) {
      let subscription: HeadSubscription | undefined;
      try {
        const lost = new AbortController();
        let lostError: unknown;
        subscription = await subscribe({
          onHead: (block) => this.update(block),
          onError: (err) => {
            lostError = err;
            lost.abort();
          },
        });
        attempt = 0;
        logger.info({}, 'ws head feed connected');
        await untilAborted(AbortSignal.any([lost.signal, signal]));
        if (!signal.aborted) logger.warn({ err: redact(lostError) }, 'ws head feed lost');
      } catch (err) {
        logger.warn({ err: redact(err), attempt }, 'ws head feed failed to connect');
      } finally {
        await subscription?.close();
      }
      if (signal.aborted) break;
      await wait(backoffDelay(attempt, random), signal);
      attempt += 1;
    }
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
