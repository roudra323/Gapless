import type { Database } from '@gapless/db';
import { describe, expect, it } from 'vitest';

import type { LeaderSession } from '../leader/leader-lock.js';
import { IndexerSupervisor, LEADER_RETRY_MS } from './indexer-supervisor.js';

type FakeSession = LeaderSession & { readonly lose: () => void; released: number };

function fakeSession(): FakeSession {
  const lost = new AbortController();
  const session = {
    db: {} as Database,
    lost: lost.signal,
    released: 0,
    lose: () => lost.abort(),
    release: () => {
      session.released += 1;
      return Promise.resolve();
    },
  };
  return session;
}

/**
 * `answers` is what each tryAcquire returns, in order (a session, null, or an error to throw).
 * `onLoop(session, signal, n)` is the body of loop number `n`.
 */
function setup(
  answers: (FakeSession | null | Error)[],
  onLoop: (session: FakeSession, signal: AbortSignal, n: number) => Promise<void>,
  maxWaits = 10,
) {
  const shutdown = new AbortController();
  const events: string[] = [];
  const status: boolean[] = [];
  const waits: number[] = [];
  let beats = 0;
  let loops = 0;

  const supervisor = new IndexerSupervisor({
    lock: {
      tryAcquire: () => {
        const answer = answers.shift();
        if (answer === undefined) {
          shutdown.abort();
          return Promise.resolve(null);
        }
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
      },
    },
    createLoop: (session) => ({
      run: (signal) => {
        loops += 1;
        return onLoop(session as FakeSession, signal, loops);
      },
    }),
    heartbeat: { beat: () => beats++ },
    leaderStatus: { set: (isLeader) => status.push(isLeader) },
    logger: {
      info: (_fields, message) => events.push(message),
      warn: (_fields, message) => events.push(message),
    },
    wait: (ms) => {
      waits.push(ms);
      if (waits.length >= maxWaits) shutdown.abort();
      return Promise.resolve();
    },
  });
  return {
    run: () => supervisor.run(shutdown.signal),
    shutdown: () => shutdown.abort(),
    events,
    status,
    waits,
    beats: () => beats,
  };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

describe('IndexerSupervisor', () => {
  it('waits as a standby, beats the heartbeat on every attempt, and logs the wait once', async () => {
    const t = setup([null, null, null], () => Promise.resolve(), 3);
    await t.run();

    expect(t.waits).toEqual([LEADER_RETRY_MS, LEADER_RETRY_MS, LEADER_RETRY_MS]);
    expect(t.beats()).toBe(3);
    expect(t.events).toEqual(['another instance is the leader, waiting']);
    expect(t.status).toEqual([]);
  });

  it('retries after a database error on the lock attempt', async () => {
    const t = setup([new Error('ECONNREFUSED'), null], () => Promise.resolve(), 2);
    await t.run();
    expect(t.events[0]).toBe('leader lock attempt failed, retrying');
    expect(t.waits).toHaveLength(2);
  });

  it('runs the loop as leader and releases the lock on shutdown', async () => {
    const session = fakeSession();
    const t = setup([session], async (_s, signal) => {
      t.shutdown();
      await untilAborted(signal);
    });
    await t.run();

    expect(t.events).toEqual(['leadership acquired']);
    expect(t.status).toEqual([true, false]);
    expect(session.released).toBe(1);
  });

  it('stops the loop when the lock is lost, then takes the lock again', async () => {
    const first = fakeSession();
    const second = fakeSession();
    const t = setup([first, second], async (session, signal, n) => {
      if (n === 1) session.lose();
      else t.shutdown();
      await untilAborted(signal);
    });
    await t.run();

    expect(t.events).toEqual([
      'leadership acquired',
      'leadership lost, waiting to acquire it again',
      'leadership acquired',
    ]);
    expect(t.status).toEqual([true, false, true, false]);
    expect(first.released).toBe(1);
    expect(second.released).toBe(1);
  });

  it('releases the lock and rejects on a fatal loop error', async () => {
    const session = fakeSession();
    const fatal = new Error('fence');
    const t = setup([session], () => Promise.reject(fatal));

    await expect(t.run()).rejects.toBe(fatal);
    expect(session.released).toBe(1);
    expect(t.status).toEqual([true, false]);
  });

  it('gives the lock back at once when the shutdown came during the attempt', async () => {
    const session = fakeSession();
    let ran = false;
    const t = setup([session], () => {
      ran = true;
      return Promise.resolve();
    });
    t.shutdown();
    // A shut-down supervisor never even tries.
    await t.run();
    expect(ran).toBe(false);
    expect(session.released).toBe(0);
  });
});
