import { describe, expect, it } from 'vitest';

import { DomainError } from './domain-error.js';
import { isDatabaseUnavailable, withDatabase } from './database-unavailable.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Like Drizzle's DrizzleQueryError: the SQL in the message, the pg error in `cause`. */
function drizzleWrap(cause: unknown): Error {
  return new Error('Failed query: select ... params: ', { cause });
}

describe('isDatabaseUnavailable', () => {
  it.each([
    ['ECONNREFUSED', withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')],
    ['ENOTFOUND (DNS)', withCode('getaddrinfo ENOTFOUND db', 'ENOTFOUND')],
    ['SQLSTATE 08006 (connection failure)', withCode('connection failure', '08006')],
    ['SQLSTATE 57P01 (admin shutdown)', withCode('terminating connection', '57P01')],
    [
      'SQLSTATE 57P03 (cannot connect now)',
      withCode('the database system is starting up', '57P03'),
    ],
    ['SQLSTATE 53300 (too many connections)', withCode('too many clients', '53300')],
    ['the pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['a socket closed mid-query', new Error('Connection terminated unexpectedly')],
  ])('is true for %s', (_label, err) => {
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect(isDatabaseUnavailable(drizzleWrap(err))).toBe(true);
  });

  it('is true for an AggregateError (localhost tries IPv6 and IPv4)', () => {
    const err = new AggregateError([
      withCode('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED'),
      withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    ]);
    expect(isDatabaseUnavailable(drizzleWrap(err))).toBe(true);
  });

  it.each([
    ['a SQL error (undefined table, 42P01)', withCode('relation "x" does not exist', '42P01')],
    ['a value out of range (22003)', withCode('value out of range', '22003')],
    ['a plain bug', new TypeError('cannot read properties of undefined')],
    ['a non-error', 'ECONNREFUSED'],
  ])('is false for %s', (_label, err) => {
    expect(isDatabaseUnavailable(drizzleWrap(err))).toBe(false);
  });

  it('stops on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(isDatabaseUnavailable(a)).toBe(false);
  });
});

describe('withDatabase', () => {
  it('returns the result', async () => {
    await expect(withDatabase(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it('turns an outage into SERVICE_UNAVAILABLE and keeps the cause', async () => {
    const outage = drizzleWrap(withCode('connect ECONNREFUSED', 'ECONNREFUSED'));
    const err: unknown = await withDatabase(() => Promise.reject(outage)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: outage });
  });

  it('rethrows any other error unchanged', async () => {
    const bug = drizzleWrap(withCode('syntax error', '42601'));
    await expect(withDatabase(() => Promise.reject(bug))).rejects.toBe(bug);
  });
});
