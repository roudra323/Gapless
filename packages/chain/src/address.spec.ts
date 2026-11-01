import { InvalidAddressError, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { normalizeAddress, toChecksum } from './address.js';

// anvil account 0; the checksummed form has both cases, so a typo in one letter breaks it.
const CHECKSUMMED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const LOWER = CHECKSUMMED.toLowerCase();

const INVALID = [
  ['a wrong checksum (one letter changed case)', CHECKSUMMED.replace('F6', 'f6')],
  ['too short', '0x1234'],
  ['too long', `${LOWER}00`],
  ['no 0x prefix', LOWER.slice(2)],
  ['an uppercase 0X prefix', `0X${LOWER.slice(2)}`],
  ['a non-hex character', `${LOWER.slice(0, -1)}g`],
  ['an empty string', ''],
] as const;

describe('normalizeAddress', () => {
  it('lowercases a checksummed address', () => {
    expect(normalizeAddress(CHECKSUMMED)).toBe(LOWER);
  });

  it('keeps an all-lowercase address as it is', () => {
    expect(normalizeAddress(LOWER)).toBe(LOWER);
  });

  it('accepts the zero address (contract checks belong to config and startup)', () => {
    expect(normalizeAddress(zeroAddress)).toBe(zeroAddress);
  });

  it.each(INVALID)('rejects %s', (_label, value) => {
    expect(() => normalizeAddress(value)).toThrow(InvalidAddressError);
  });
});

describe('toChecksum', () => {
  it('checksums an all-lowercase address', () => {
    expect(toChecksum(LOWER)).toBe(CHECKSUMMED);
  });

  it('keeps a checksummed address as it is', () => {
    expect(toChecksum(CHECKSUMMED)).toBe(CHECKSUMMED);
  });

  it('round-trips with normalizeAddress', () => {
    expect(toChecksum(normalizeAddress(CHECKSUMMED))).toBe(CHECKSUMMED);
  });

  it.each(INVALID)('rejects %s instead of "fixing" it', (_label, value) => {
    expect(() => toChecksum(value)).toThrow(InvalidAddressError);
  });
});
