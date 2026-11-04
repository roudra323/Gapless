import { describe, expect, it } from 'vitest';

import { DomainError, ERROR_CODE } from './domain-error.js';

describe('DomainError', () => {
  it('carries the code and the message', () => {
    const err = new DomainError(ERROR_CODE.INVALID_CURSOR, 'cursor is not valid');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe('DomainError');
    expect(err.code).toBe('INVALID_CURSOR');
    expect(err.message).toBe('cursor is not valid');
  });

  it('keeps the inner error as the standard cause', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const err = new DomainError(ERROR_CODE.SERVICE_UNAVAILABLE, 'database unreachable', inner);

    expect(err.cause).toBe(inner);
  });

  it('has no cause property when none is given', () => {
    const err = new DomainError(ERROR_CODE.NOT_FOUND, 'no route');

    // `in`, not `toBeUndefined`: a key set to undefined would still print as `cause: undefined`.
    expect('cause' in err).toBe(false);
  });

  it('uses each code as its own value', () => {
    for (const [key, value] of Object.entries(ERROR_CODE)) expect(value).toBe(key);
  });
});
