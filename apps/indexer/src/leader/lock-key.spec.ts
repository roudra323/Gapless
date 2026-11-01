import { describe, expect, it } from 'vitest';

import { advisoryLockKey } from './lock-key.js';

const TOKEN = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

describe('advisoryLockKey', () => {
  it('is the same for the same chain and token, whatever the address case', () => {
    expect(advisoryLockKey(31337, TOKEN)).toBe(advisoryLockKey(31337, TOKEN));
    expect(advisoryLockKey(31337, '0x5FbDB2315678afecb367f032d93F642f64180aa3')).toBe(
      advisoryLockKey(31337, TOKEN),
    );
  });

  it('differs for another chain or another token', () => {
    const key = advisoryLockKey(31337, TOKEN);
    expect(advisoryLockKey(84532, TOKEN)).not.toBe(key);
    expect(advisoryLockKey(31337, `0x${'9'.repeat(40)}`)).not.toBe(key);
  });

  it('fits a Postgres bigint (signed 64-bit)', () => {
    for (const chainId of [1, 31337, 84532, 2 ** 31]) {
      const key = advisoryLockKey(chainId, TOKEN);
      expect(key).toBeGreaterThanOrEqual(INT64_MIN);
      expect(key).toBeLessThanOrEqual(INT64_MAX);
    }
  });
});
