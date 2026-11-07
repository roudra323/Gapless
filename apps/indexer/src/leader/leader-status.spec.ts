import { describe, expect, it } from 'vitest';

import { LeaderStatus } from './leader-status.js';

describe('LeaderStatus', () => {
  it('starts as not leader and reports every change to onChange', () => {
    const changes: boolean[] = [];
    const status = new LeaderStatus((isLeader) => changes.push(isLeader));
    expect(status.isLeader()).toBe(false);

    status.set(true);
    expect(status.isLeader()).toBe(true);
    status.set(false);
    expect(changes).toEqual([true, false]);
  });
});
