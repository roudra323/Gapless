import { DomainError, ERROR_CODE } from './domain-error.js';

/** Node socket errors: the database host cannot be reached or dropped the connection. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Postgres SQLSTATEs that mean "the server can't serve you now": class 08 (connection exception),
 * 57P01–57P03 (shutdown, crash shutdown, cannot connect now) and 53300 (too many connections).
 */
const UNAVAILABLE_SQLSTATE = /^(08...|57P0[1-3]|53300)$/;

/** `pg` errors with no code: the pool's connect timeout and a socket closed mid-query. */
const UNAVAILABLE_MESSAGE = /timeout exceeded when trying to connect|connection terminated/i;

/** Drizzle wraps the `pg` error in `cause`, and Node wraps dual-stack failures in AggregateError. */
const MAX_DEPTH = 5;

/**
 * True when `err` (or an error inside it) says the database is unreachable, as opposed to a bug
 * such as a bad query. Unreachable → 503 the client may retry; a bug → 500.
 */
export function isDatabaseUnavailable(err: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || !(err instanceof Error)) return false;
  const code: unknown = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATE.test(code))) {
    return true;
  }
  if (UNAVAILABLE_MESSAGE.test(err.message)) return true;
  if (
    err instanceof AggregateError &&
    err.errors.some((e) => isDatabaseUnavailable(e, depth + 1))
  ) {
    return true;
  }
  return isDatabaseUnavailable(err.cause, depth + 1);
}

/**
 * Runs a query and turns an outage into `DomainError(SERVICE_UNAVAILABLE)`, with the real error as
 * the cause (the filter logs it). Any other error is rethrown as it is, and becomes a 500.
 */
export async function withDatabase<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (err) {
    if (isDatabaseUnavailable(err)) {
      throw new DomainError(ERROR_CODE.SERVICE_UNAVAILABLE, 'The database is unavailable.', err);
    }
    throw err;
  }
}
