import { describe, expect, it } from 'vitest';

import type { Transfer } from './transfer.js';
import { toTransferResponse } from './transfer.response.js';

const TRANSFER: Transfer = {
  txHash: `0x${'ab'.repeat(32)}`,
  logIndex: 3,
  // Above 2^53, so a Number conversion anywhere would change the digits.
  blockNumber: 9007199254740993n,
  blockTimestamp: new Date('2026-10-21T10:00:00Z'),
  from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  // The largest uint256: 78 digits.
  value: 2n ** 256n - 1n,
};

describe('toTransferResponse', () => {
  it('returns exactly the docs/02 shape', () => {
    expect(toTransferResponse(TRANSFER)).toEqual({
      txHash: TRANSFER.txHash,
      logIndex: 3,
      blockNumber: '9007199254740993',
      blockTimestamp: '2026-10-21T10:00:00.000Z',
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    });
  });

  it('serializes to JSON without a bigint error', () => {
    // JSON.stringify throws on a bigint, so a missed conversion would be a 500 in production.
    expect(() => JSON.stringify(toTransferResponse(TRANSFER))).not.toThrow();
  });
});
