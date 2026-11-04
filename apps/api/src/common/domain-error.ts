/**
 * Every `errorCode` the API can return in a problem+json body (docs/02 "Errors"). Clients match on
 * these strings, so a code never changes meaning once released.
 */
export const ERROR_CODE = {
  /** A query or path value failed its schema (for example `limit=0`). */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The `:address` path value is not a 0x address. */
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  /** The `cursor` is not one this API issued (malformed or changed by hand). */
  INVALID_CURSOR: 'INVALID_CURSOR',
  /** No route matches the method and path. */
  NOT_FOUND: 'NOT_FOUND',
  /** A dependency (the database) is unreachable; the client may retry. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Anything unexpected. The details stay in the server log. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/**
 * An expected failure in the API's own terms, thrown by services and repositories (docs/05
 * "Errors"). It knows nothing about HTTP: the problem+json filter maps `code` to a status.
 *
 * `cause` is the standard `Error` cause (ES2022), so the logger prints the inner error too.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DomainError';
  }
}
