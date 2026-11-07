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
  /**
   * The stall rule (docs/03 "HeadTracker"): the socket counts as dead when the poll has seen a
   * head that the socket has not delivered for longer than this (3 × `BLOCK_TIME_MS`). A quiet
   * chain never trips it, because then the poll is not ahead either.
   */
  readonly wsStallAfterMs: number;
  /** The clock for the stall rule, in ms. `Date.now` by default. */
  readonly now?: () => number;
  /** Called on every head change, from either source (the `head_block` gauge, docs/09). */
  readonly onHeadChange?: (head: bigint) => void;
  /** Called when the WS head feed turns healthy or not (the `ws_connected` gauge, docs/09). */
  readonly onWsConnected?: (connected: boolean) => void;
  /** Called on each subscribe attempt after the first (the `ws_reconnects_total` counter). */
  readonly onWsReconnect?: () => void;
};

/**
 * Keeps the latest chain head and wakes the ingestion loop when it changes (docs/03
 * "HeadTracker"). It never carries event data: the loop always reads logs over HTTP from the
 * checkpoint, so a lost socket can't cause a gap.
 *
 * - The **poll source** reads the head every `pollIntervalMs`. It always runs, even while the
 *   WebSocket is healthy, so progress never depends on the socket.
 * - The **WS source** (only with `RPC_WS_URL`) gets each new head at once. When the socket dies,
 *   or stays silent while the poll sees newer heads (the stall rule), it subscribes again after
 *   `backoffDelay`, forever.
 */
export class HeadTracker {
  private head: bigint | undefined;
  /** Increases on every head change, so a waiter can't miss a change that came before it. */
  private changes = 0;
  private readonly waiters = new Set<() => void>();
  private readonly stopController = new AbortController();
  private running: Promise<void>[] = [];

  // The stall rule's state, for the live subscription only (all unset while there is none).
  /** Drops the live subscription as stalled. */
  private dropStalledSocket: (() => void) | undefined;
  /** The highest head the live socket delivered, or the poll's head when it connected. */
  private wsDelivered: bigint | undefined;
  /** When the poll first saw a head above `wsDelivered`, in ms. */
  private wsBehindSince: number | undefined;
  /** The latest head from the poll. */
  private polled: bigint | undefined;

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
    // 0 until a subscription is up; stays 0 in poll-only mode.
    this.deps.onWsConnected?.(false);
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
    this.deps.onWsConnected?.(false);
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
        const head = await sources.pollHead();
        this.update(head);
        this.checkWsStall(head);
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

  /**
   * The stall rule (docs/03 "HeadTracker"), run after each successful poll: when the poll has been
   * ahead of the socket for longer than `wsStallAfterMs`, drop the socket so it reconnects.
   */
  private checkWsStall(head: bigint): void {
    this.polled = head;
    if (this.dropStalledSocket === undefined) return;
    if (this.wsDelivered === undefined || this.wsDelivered >= head) {
      // A socket that connected before the first poll starts from the poll's head.
      this.wsDelivered ??= head;
      this.wsBehindSince = undefined;
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    this.wsBehindSince ??= now;
    const behindMs = now - this.wsBehindSince;
    if (behindMs <= this.deps.wsStallAfterMs) return;
    this.deps.logger.warn(
      { pollHead: head.toString(), wsHead: this.wsDelivered.toString(), behindMs },
      'ws head feed stalled, reconnecting',
    );
    this.dropStalledSocket();
  }

  private onWsHead(block: bigint): void {
    if (this.wsDelivered === undefined || block > this.wsDelivered) this.wsDelivered = block;
    if (this.polled === undefined || this.wsDelivered >= this.polled)
      this.wsBehindSince = undefined;
    this.update(block);
  }

  private async subscribeForever(
    subscribe: NonNullable<HeadSources['subscribeHeads']>,
    signal: AbortSignal,
  ): Promise<void> {
    const { logger, redact, wait, random, onWsConnected, onWsReconnect } = this.deps;
    let attempt = 0;
    let first = true;
    while (!signal.aborted) {
      if (!first) onWsReconnect?.();
      first = false;
      let subscription: HeadSubscription | undefined;
      try {
        const lost = new AbortController();
        let lostError: unknown;
        let stalled = false;
        subscription = await subscribe({
          onHead: (block) => this.onWsHead(block),
          onError: (err) => {
            lostError = err;
            lost.abort();
          },
        });
        attempt = 0;
        this.wsDelivered = this.polled;
        this.wsBehindSince = undefined;
        this.dropStalledSocket = () => {
          stalled = true;
          lost.abort();
        };
        onWsConnected?.(true);
        logger.info({}, 'ws head feed connected');
        await untilAborted(AbortSignal.any([lost.signal, signal]));
        // A stall was already logged by `checkWsStall`.
        if (!signal.aborted && !stalled) {
          logger.warn({ err: redact(lostError) }, 'ws head feed lost');
        }
      } catch (err) {
        logger.warn({ err: redact(err), attempt }, 'ws head feed failed to connect');
      } finally {
        this.dropStalledSocket = undefined;
        this.wsDelivered = undefined;
        this.wsBehindSince = undefined;
        onWsConnected?.(false);
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
