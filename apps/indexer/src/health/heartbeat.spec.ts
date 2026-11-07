import { describe, expect, it } from 'vitest';

import { Heartbeat } from './heartbeat.js';

describe('Heartbeat', () => {
  it('reports boot and every beat to onBeat, with the beat time', () => {
    let now = 1000;
    const beats: number[] = [];
    const heartbeat = new Heartbeat(
      () => now,
      (atMs) => beats.push(atMs),
    );
    now = 2500;
    heartbeat.beat();

    expect(beats).toEqual([1000, 2500]);
    expect(heartbeat.lastBeatAt()).toBe(2500);
  });
});
