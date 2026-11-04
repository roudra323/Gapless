import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER, requestId } from './request-id.js';

function call(header?: string | string[]) {
  const headers: Record<string, unknown> = {};
  const req = { headers: header === undefined ? {} : { [REQUEST_ID_HEADER]: header } };
  const res = { setHeader: (name: string, value: unknown) => (headers[name] = value) };
  const id = requestId(req as IncomingMessage, res as unknown as ServerResponse);
  return { id, sent: headers[REQUEST_ID_HEADER] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('requestId', () => {
  it('keeps a valid incoming x-request-id and sends it back', () => {
    expect(call('gw-1234.abc:5')).toEqual({ id: 'gw-1234.abc:5', sent: 'gw-1234.abc:5' });
  });

  it('makes a UUID when there is no header', () => {
    const { id, sent } = call();
    expect(id).toMatch(UUID);
    expect(sent).toBe(id);
  });

  it.each([
    ['a line break (log injection)', 'abc\n{"level":"fatal"}'],
    ['spaces', 'a b'],
    ['an empty value', ''],
    ['a huge value', 'a'.repeat(129)],
  ])('replaces %s with a UUID', (_label, header) => {
    expect(call(header).id).toMatch(UUID);
  });

  it('replaces a repeated header (an array) with a UUID', () => {
    expect(call(['a', 'b']).id).toMatch(UUID);
  });
});
