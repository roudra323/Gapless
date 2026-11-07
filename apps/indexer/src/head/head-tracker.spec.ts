import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeadTracker, type HeadSources, type HeadSubscribeHandlers } from './head-tracker.js';

type Line = { level: 'info' | 'warn'; fields: Record<string, unknown>; message: string };

/** A `wait` that records each requested delay and yields for 1 ms instead. */
function fastWait(waits: number[]) {
  return async (ms: number, signal: AbortSignal): Promise<void> => {
    waits.push(ms);
    await delay(1, undefined, { signal }).catch(() => undefined);
  };
}

const STALL_AFTER_MS = 3000;

function build(sources: HeadSources, pollIntervalMs = 1000, now?: () => number) {
  const lines: Line[] = [];
  const waits: number[] = [];
  const changes: bigint[] = [];
  const connected: boolean[] = [];
  const reconnects = { count: 0 };
  const tracker = new HeadTracker({
    sources,
    pollIntervalMs,
    logger: {
      info: (fields, message) => lines.push({ level: 'info', fields, message }),
      warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    },
    redact: (err) => (err instanceof Error ? `redacted: ${err.message}` : err),
    wait: fastWait(waits),
    random: () => 0.5,
    wsStallAfterMs: STALL_AFTER_MS,
    now,
    onHeadChange: (head) => changes.push(head),
    onWsConnected: (value) => connected.push(value),
    onWsReconnect: () => (reconnects.count += 1),
  });
  return { tracker, lines, waits, changes, connected, reconnects };
}

/** A fake WS source: the test pushes heads and kills the socket. */
function fakeSocket(options: { failConnects?: number } = {}) {
  let handlers: HeadSubscribeHandlers | undefined;
  let failConnects = options.failConnects ?? 0;
  const stats = { connects: 0, closes: 0 };
  const subscribeHeads = (h: HeadSubscribeHandlers) => {
    stats.connects += 1;
    if (failConnects > 0) {
      failConnects -= 1;
      return Promise.reject(new Error('connection refused'));
    }
    handlers = h;
    return Promise.resolve({
      close: () => {
        stats.closes += 1;
        return Promise.resolve();
      },
    });
  };
  return {
    subscribeHeads,
    stats,
    push: (block: bigint) => handlers?.onHead(block),
    kill: () => handlers?.onError(new Error('socket closed')),
  };
}

let stopAll: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stopAll.map((stop) => stop()));
  stopAll = [];
});

function started(tracker: HeadTracker): HeadTracker {
  tracker.start();
  stopAll.push(() => tracker.stop());
  return tracker;
}

describe('HeadTracker', () => {
  it('reads the head from the poll source and keeps polling', async () => {
    let head = 10n;
    const { tracker, waits } = build({ pollHead: () => Promise.resolve(head) }, 4000);
    started(tracker);

    await vi.waitFor(() => expect(tracker.latest()).toBe(10n));
    head = 11n;
    await vi.waitFor(() => expect(tracker.latest()).toBe(11n));
    expect(waits.every((ms) => ms === 4000)).toBe(true);
  });

  it('wakes a waiter when the head changes', async () => {
    const socket = fakeSocket();
    const { tracker } = build({ pollHead: () => Promise.resolve(1n), ...socket }, 60_000);
    started(tracker);
    await vi.waitFor(() => expect(socket.stats.connects).toBe(1));

    const since = tracker.version();
    const woke = tracker.waitForChange(new AbortController().signal, 60_000, since);
    socket.push(42n);
    await woke;
    expect(tracker.latest()).toBe(42n);
  });

  it('reports each head change once, from both sources (the head_block gauge)', async () => {
    const socket = fakeSocket();
    const { tracker, changes } = build({ pollHead: () => Promise.resolve(5n), ...socket }, 60_000);
    started(tracker);
    await vi.waitFor(() => expect(socket.stats.connects).toBe(1));
    await vi.waitFor(() => expect(tracker.latest()).toBe(5n));

    socket.push(5n); // the same head again: no change
    socket.push(6n);
    expect(changes).toEqual([5n, 6n]);
  });

  it('resolves at once for a change that came before the wait started', async () => {
    const socket = fakeSocket();
    const { tracker } = build({ pollHead: () => Promise.resolve(1n), ...socket }, 60_000);
    started(tracker);
    await vi.waitFor(() => expect(socket.stats.connects).toBe(1));

    const since = tracker.version();
    socket.push(7n);
    // No timer, no abort: only the version tells it that a change already happened.
    await tracker.waitForChange(new AbortController().signal, 60_000, since);
    expect(tracker.latest()).toBe(7n);
  });

  it('resolves on the timeout and on an abort when nothing changes', async () => {
    const { tracker } = build({ pollHead: () => Promise.resolve(1n) }, 60_000);
    started(tracker);
    await vi.waitFor(() => expect(tracker.latest()).toBe(1n));

    await tracker.waitForChange(new AbortController().signal, 5);
    const abort = new AbortController();
    const waiting = tracker.waitForChange(abort.signal, 60_000);
    abort.abort();
    await waiting;
  });

  it('subscribes again with backoff after the socket dies', async () => {
    const socket = fakeSocket();
    const { tracker, lines, waits } = build({ pollHead: () => Promise.resolve(1n), ...socket });
    started(tracker);
    await vi.waitFor(() => expect(socket.stats.connects).toBe(1));

    socket.kill();
    await vi.waitFor(() => expect(socket.stats.connects).toBe(2));
    expect(socket.stats.closes).toBe(1);
    expect(lines.map((l) => l.message)).toEqual([
      'ws head feed connected',
      'ws head feed lost',
      'ws head feed connected',
    ]);
    // The lost error is redacted before it is logged.
    expect(lines[1]?.fields.err).toBe('redacted: socket closed');
    // Backoff with random() = 0.5 on attempt 0: half of the 500 ms base.
    expect(waits).toContain(250);
  });

  it('grows the backoff while the socket can not connect, then resets it', async () => {
    const socket = fakeSocket({ failConnects: 3 });
    const { tracker, lines, waits } = build(
      { pollHead: () => Promise.resolve(1n), ...socket },
      4000,
    );
    started(tracker);

    await vi.waitFor(() => expect(socket.stats.connects).toBe(4));
    const backoffs = waits.filter((ms) => ms !== 4000);
    expect(backoffs).toEqual([250, 500, 1000]);
    expect(lines.filter((l) => l.message === 'ws head feed failed to connect')).toHaveLength(3);
    await vi.waitFor(() => expect(lines.at(-1)?.message).toBe('ws head feed connected'));
  });

  it('keeps polling while the socket is down (poll-only progress)', async () => {
    let head = 5n;
    const socket = fakeSocket({ failConnects: 1_000_000 });
    const { tracker } = build({ pollHead: () => Promise.resolve(head), ...socket });
    started(tracker);

    await vi.waitFor(() => expect(tracker.latest()).toBe(5n));
    head = 6n;
    await vi.waitFor(() => expect(tracker.latest()).toBe(6n));
  });

  it('logs one warning per poll outage, then a recovery', async () => {
    let failing = true;
    const { tracker, lines } = build({
      pollHead: () => (failing ? Promise.reject(new Error('down')) : Promise.resolve(3n)),
    });
    started(tracker);

    await vi.waitFor(() => expect(lines).toHaveLength(1));
    await delay(20);
    expect(lines).toEqual([
      { level: 'warn', fields: { err: 'redacted: down' }, message: 'head poll failed' },
    ]);
    failing = false;
    await vi.waitFor(() => expect(tracker.latest()).toBe(3n));
    expect(lines.at(-1)?.message).toBe('head poll recovered');
  });

  it('stops both sources, closes the socket, and wakes the waiters', async () => {
    const socket = fakeSocket();
    let polls = 0;
    const { tracker } = build({
      pollHead: () => {
        polls += 1;
        return Promise.resolve(1n);
      },
      ...socket,
    });
    tracker.start();
    await vi.waitFor(() => expect(socket.stats.connects).toBe(1));
    const waiting = tracker.waitForChange(new AbortController().signal, 60_000);

    await tracker.stop();
    await waiting;
    expect(socket.stats.closes).toBe(1);
    const after = polls;
    await delay(20);
    expect(polls).toBe(after);
  });

  describe('ws_connected, reconnects and the stall rule', () => {
    it('reports the feed as up while subscribed, down after a loss, and counts the reconnect', async () => {
      const socket = fakeSocket();
      const { tracker, connected, reconnects } = build({
        pollHead: () => Promise.resolve(1n),
        ...socket,
      });
      tracker.start();
      await vi.waitFor(() => expect(connected).toEqual([false, true]));

      socket.kill();
      await vi.waitFor(() => expect(socket.stats.connects).toBe(2));
      await vi.waitFor(() => expect(connected).toEqual([false, true, false, true]));
      expect(reconnects.count).toBe(1);

      await tracker.stop();
      expect(connected.at(-1)).toBe(false);
    });

    it('counts every failed attempt as a reconnect and stays down until one works', async () => {
      const socket = fakeSocket({ failConnects: 3 });
      const { tracker, connected, reconnects } = build({
        pollHead: () => Promise.resolve(1n),
        ...socket,
      });
      started(tracker);

      await vi.waitFor(() => expect(connected.at(-1)).toBe(true));
      expect(socket.stats.connects).toBe(4);
      expect(reconnects.count).toBe(3);
      expect(connected.filter((value) => value)).toHaveLength(1);
    });

    it('stays down in poll-only mode', async () => {
      const { tracker, connected, reconnects } = build({ pollHead: () => Promise.resolve(1n) });
      started(tracker);
      await vi.waitFor(() => expect(tracker.latest()).toBe(1n));
      await delay(10);
      expect(connected).toEqual([false]);
      expect(reconnects.count).toBe(0);
    });

    it('drops a socket that stays silent while the poll sees newer heads, then reconnects', async () => {
      let clock = 0;
      let head = 100n;
      const socket = fakeSocket();
      const { tracker, lines, connected, reconnects } = build(
        {
          // Each poll is one second later and one block higher; the socket delivers nothing.
          pollHead: () => {
            clock += 1000;
            head += 1n;
            return Promise.resolve(head);
          },
          ...socket,
        },
        1000,
        () => clock,
      );
      started(tracker);

      await vi.waitFor(() => expect(socket.stats.connects).toBeGreaterThanOrEqual(2));
      const stall = lines.find((line) => line.message === 'ws head feed stalled, reconnecting');
      expect(stall?.level).toBe('warn');
      expect(stall?.fields.behindMs).toBeGreaterThan(STALL_AFTER_MS);
      // Logged once as a stall, not again as a lost socket.
      expect(lines.some((line) => line.message === 'ws head feed lost')).toBe(false);
      expect(socket.stats.closes).toBeGreaterThanOrEqual(1);
      expect(reconnects.count).toBeGreaterThanOrEqual(1);
      expect(connected.slice(0, 3)).toEqual([false, true, false]);
    });

    it('never drops a socket on a quiet chain (no new heads at all)', async () => {
      let clock = 0;
      const socket = fakeSocket();
      let polls = 0;
      const { tracker, connected } = build(
        {
          pollHead: () => {
            polls += 1;
            clock += 60_000;
            return Promise.resolve(5n);
          },
          ...socket,
        },
        1000,
        () => clock,
      );
      started(tracker);

      await vi.waitFor(() => expect(polls).toBeGreaterThan(20));
      expect(socket.stats.connects).toBe(1);
      expect(connected).toEqual([false, true]);
    });

    it('keeps a socket that delivers the heads the poll sees', async () => {
      let clock = 0;
      let head = 100n;
      let polls = 0;
      const socket = fakeSocket();
      const { tracker } = build(
        {
          pollHead: () => {
            polls += 1;
            clock += 1000;
            head += 1n;
            socket.push(head);
            return Promise.resolve(head);
          },
          ...socket,
        },
        1000,
        () => clock,
      );
      started(tracker);

      await vi.waitFor(() => expect(polls).toBeGreaterThan(20));
      expect(socket.stats.connects).toBe(1);
    });
  });
});
