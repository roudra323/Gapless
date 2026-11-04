import { describe, expect, it } from 'vitest';

import {
  type Cursor,
  decodeCursor,
  encodeCursor,
  MAX_BLOCK_NUMBER,
  MAX_LOG_INDEX,
} from './cursor.js';
import { DomainError } from './domain-error.js';

/** base64url of any text, to build hand-made (bad) cursors. */
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** The error `decodeCursor` throws, or `undefined` if it returns. */
function errorFor(text: string): unknown {
  try {
    decodeCursor(text);
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectInvalid(text: string): void {
  const thrown = errorFor(text);
  expect(thrown).toBeInstanceOf(DomainError);
  expect(thrown).toMatchObject({ code: 'INVALID_CURSOR', message: 'The cursor is not valid.' });
}

describe('encodeCursor', () => {
  it('makes base64url JSON with the block number as a decimal string (docs/02)', () => {
    const text = encodeCursor({ blockNumber: 1234n, logIndex: 3 });

    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(text, 'base64url').toString('utf8')).toBe('{"b":"1234","l":3}');
  });
});

describe('decodeCursor', () => {
  it.each<Cursor>([
    { blockNumber: 0n, logIndex: 0 },
    { blockNumber: 1234n, logIndex: 3 },
    // Above 2^53: a JSON number would round this; the decimal string keeps it exact.
    { blockNumber: 9007199254740993n, logIndex: 7 },
    { blockNumber: MAX_BLOCK_NUMBER, logIndex: MAX_LOG_INDEX },
  ])('round-trips %o', (cursor) => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  describe('rejects malformed cursors', () => {
    it.each([
      ['an empty string', ''],
      ['not base64', '!!!'],
      ['base64 of non-JSON', b64('hello')],
      ['JSON that is not an object', b64('[1,2]')],
      ['a very long value', 'A'.repeat(129)],
    ])('%s', (_label, text) => expectInvalid(text));
  });

  describe('rejects cursors that were changed by hand', () => {
    it.each([
      ['a missing key', b64('{"b":"1"}')],
      ['an extra key', b64('{"b":"1","l":0,"x":1}')],
      ['b as a number', b64('{"b":1,"l":0}')],
      ['a negative block', b64('{"b":"-1","l":0}')],
      ['a decimal block', b64('{"b":"1.5","l":0}')],
      ['a block with leading zeros', b64('{"b":"01","l":0}')],
      ['a block above the Postgres bigint', b64(`{"b":"${MAX_BLOCK_NUMBER + 1n}","l":0}`)],
      ['a negative log index', b64('{"b":"1","l":-1}')],
      ['a decimal log index', b64('{"b":"1","l":0.5}')],
      ['a log index above the Postgres integer', b64(`{"b":"1","l":${MAX_LOG_INDEX + 1}}`)],
      ['a log index of 1e400 (Infinity)', b64('{"b":"1","l":1e400}')],
    ])('%s', (_label, text) => expectInvalid(text));
  });

  describe('accepts only the exact text encodeCursor makes', () => {
    const valid = encodeCursor({ blockNumber: 1n, logIndex: 0 });

    // Buffer.from(…, 'base64url') skips unknown characters and padding, and JSON.parse allows
    // spaces and other spellings of the same value. Each would decode to the same position.
    it.each([
      ['extra characters', `${valid}!!`],
      ['padding', `${valid}==`],
      ['spaces in the JSON', b64('{ "b": "1", "l": 0 }')],
      ['the keys in another order', b64('{"l":0,"b":"1"}')],
      ['1.0 for 1', b64('{"b":"1","l":0.0}')],
    ])('%s', (_label, text) => expectInvalid(text));
  });

  it('never puts the input in the error', () => {
    const text = b64('{"b":"hunter2","l":0}');
    const thrown = errorFor(text);

    expect(thrown).toBeInstanceOf(DomainError);
    expect(String(thrown)).not.toContain('hunter2');
    expect(String(thrown)).not.toContain(text);
  });
});
