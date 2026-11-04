import { describe, expect, it } from 'vitest';

import {
  addressParamSchema,
  addressTransfersQuerySchema,
  DEFAULT_LIMIT,
  listTransfersQuerySchema,
} from './transfers.schemas.js';

const CHECKSUMMED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('listTransfersQuerySchema', () => {
  it('defaults limit to 25 and leaves the cursor unset', () => {
    expect(listTransfersQuerySchema.parse({})).toEqual({ limit: DEFAULT_LIMIT });
  });

  it.each([
    ['1', 1],
    ['100', 100],
  ])('accepts limit=%s', (value, expected) => {
    expect(listTransfersQuerySchema.parse({ limit: value }).limit).toBe(expected);
  });

  it.each([
    ['0', 'too small'],
    ['101', 'too big'],
    ['', 'empty (z.coerce would make it 0)'],
    ['1e2', 'an exponent'],
    [' 5', 'padded'],
    ['2.5', 'a decimal'],
    ['-1', 'negative'],
  ])('rejects limit=%j (%s)', (value) => {
    expect(listTransfersQuerySchema.safeParse({ limit: value }).success).toBe(false);
  });

  it('rejects a repeated limit (?limit=1&limit=2 arrives as an array)', () => {
    expect(listTransfersQuerySchema.safeParse({ limit: ['1', '2'] }).success).toBe(false);
  });

  it('keeps the cursor as a string for the service to decode', () => {
    expect(listTransfersQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });

  it.each([
    ['empty', ''],
    ['too long', 'A'.repeat(129)],
  ])('rejects a cursor that is %s', (_label, value) => {
    expect(listTransfersQuerySchema.safeParse({ cursor: value }).success).toBe(false);
  });

  it('drops unknown keys', () => {
    expect(listTransfersQuerySchema.parse({ utm_source: 'x' })).toEqual({ limit: DEFAULT_LIMIT });
  });
});

describe('addressTransfersQuerySchema', () => {
  it('defaults direction to all', () => {
    expect(addressTransfersQuerySchema.parse({})).toEqual({
      limit: DEFAULT_LIMIT,
      direction: 'all',
    });
  });

  it.each(['in', 'out', 'all'])('accepts direction=%s', (direction) => {
    expect(addressTransfersQuerySchema.parse({ direction }).direction).toBe(direction);
  });

  it.each(['IN', 'both', ''])('rejects direction=%j', (direction) => {
    expect(addressTransfersQuerySchema.safeParse({ direction }).success).toBe(false);
  });
});

describe('addressParamSchema', () => {
  it('returns a checksummed address lowercase', () => {
    expect(addressParamSchema.parse(CHECKSUMMED)).toBe(CHECKSUMMED.toLowerCase());
  });

  it('accepts an all-lowercase address', () => {
    expect(addressParamSchema.parse(CHECKSUMMED.toLowerCase())).toBe(CHECKSUMMED.toLowerCase());
  });

  it.each([
    ['a wrong checksum (typo)', CHECKSUMMED.replace('F6', 'f6')],
    ['too short', '0x1234'],
    ['no 0x prefix', CHECKSUMMED.slice(2)],
    ['not hex', `0x${'z'.repeat(40)}`],
  ])('rejects %s', (_label, value) => {
    expect(addressParamSchema.safeParse(value).success).toBe(false);
  });
});
