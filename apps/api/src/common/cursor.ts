import { z } from 'zod';

import { DomainError, ERROR_CODE } from './domain-error.js';

/**
 * A position in the transfer list: the last row of a page. The next page starts after it, in the
 * sort order `block_number DESC, log_index DESC` (docs/02 "Pagination").
 */
export type Cursor = {
  readonly blockNumber: bigint;
  readonly logIndex: number;
};

/** The largest Postgres `bigint` (`transfers.block_number`). A larger value would fail in SQL. */
export const MAX_BLOCK_NUMBER = 2n ** 63n - 1n;

/** The largest Postgres `integer` (`transfers.log_index`). */
export const MAX_LOG_INDEX = 2 ** 31 - 1;

/** A real cursor is about 40 characters. Anything much longer is not one of ours. */
const MAX_CURSOR_LENGTH = 128;

/**
 * The JSON inside a cursor: `{ b, l }` (docs/02). `b` is a decimal string, because JSON numbers
 * lose precision above 2^53 and a block number is a `bigint` (docs/05 "Blockchain values").
 */
const cursorJsonSchema = z.strictObject({
  b: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .transform((value) => BigInt(value))
    .refine((value) => value <= MAX_BLOCK_NUMBER),
  l: z.int().min(0).max(MAX_LOG_INDEX),
});

/** Encodes a position as base64url JSON. The text is opaque to clients: they only send it back. */
export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ b: cursor.blockNumber.toString(), l: cursor.logIndex });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor from {@link encodeCursor}.
 *
 * Only the exact text `encodeCursor` would make is accepted: the result is encoded again and must
 * match the input. That rejects what `Buffer` and `JSON.parse` silently accept (unknown
 * characters, padding, spaces, `1.0`, leading zeros), so one position has one cursor.
 *
 * A cursor edited to another valid position is accepted. That is safe: the data is public, and
 * the query is still bounded by `limit`.
 *
 * @throws {DomainError} `INVALID_CURSOR` for anything else. The message never repeats the input.
 */
export function decodeCursor(text: string): Cursor {
  if (text.length === 0 || text.length > MAX_CURSOR_LENGTH) throw invalidCursor();

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch (err) {
    throw invalidCursor(err);
  }

  const parsed = cursorJsonSchema.safeParse(json);
  if (!parsed.success) throw invalidCursor(parsed.error);

  const cursor: Cursor = { blockNumber: parsed.data.b, logIndex: parsed.data.l };
  if (encodeCursor(cursor) !== text) throw invalidCursor();
  return cursor;
}

function invalidCursor(cause?: unknown): DomainError {
  return new DomainError(ERROR_CODE.INVALID_CURSOR, 'The cursor is not valid.', cause);
}
