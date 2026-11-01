import { describe, expect, it } from 'vitest';

import { Heartbeat } from './heartbeat.js';
import { isLive, isReady, livenessWindowMs } from './health-status.js';

describe('livenessWindowMs', () => {
  it('is at least 60 s', () => {
    expect(livenessWindowMs(100)).toBe(60_000);
    expect(livenessWindowMs(4000)).toBe(60_000);
  });

  it('is 5 poll intervals for a slow poll', () => {
    expect(livenessWindowMs(20_000)).toBe(100_000);
  });
});

describe('isLive', () => {
  it('is live up to the edge of the window, and not after it', () => {
    expect(isLive(0, 60_000, 4000)).toBe(true);
    expect(isLive(0, 60_001, 4000)).toBe(false);
  });
});

describe('isReady', () => {
  it('needs both the lock and the database', () => {
    expect(isReady({ isLeader: true, dbReachable: true })).toBe(true);
    expect(isReady({ isLeader: false, dbReachable: true })).toBe(false);
    expect(isReady({ isLeader: true, dbReachable: false })).toBe(false);
  });
});

describe('Heartbeat', () => {
  it('counts the boot as a beat, then records each beat', () => {
    let now = 1000;
    const heartbeat = new Heartbeat(() => now);
    expect(heartbeat.lastBeatAt()).toBe(1000);
    now = 5000;
    heartbeat.beat();
    expect(heartbeat.lastBeatAt()).toBe(5000);
  });
});
