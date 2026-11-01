import { describe, expect, it } from 'vitest';

import { redactRpcUrl } from './rpc-error.js';

const URL_WITH_KEY = 'https://eth.provider.example/v2/key-hunter2';

describe('redactRpcUrl', () => {
  it('replaces the path and keeps the scheme and host', () => {
    const err = redactRpcUrl(new Error(`failed: ${URL_WITH_KEY}`), URL_WITH_KEY) as Error;
    expect(err.message).toBe('failed: https://eth.provider.example/<redacted>');
  });

  it('redacts the message, stack, fields, cause chain and AggregateError entries', () => {
    const inner = new Error(`connect to ${URL_WITH_KEY}`);
    const aggregate = new AggregateError([inner], 'all attempts failed');
    const outer = Object.assign(new Error(`request to ${URL_WITH_KEY}`, { cause: aggregate }), {
      url: URL_WITH_KEY,
      body: { method: 'eth_getLogs', params: [URL_WITH_KEY] },
      status: 429,
    });

    const copy = redactRpcUrl(outer, URL_WITH_KEY) as Error & Record<string, unknown>;

    expect(copy.message).not.toContain('hunter2');
    expect(copy.stack).not.toContain('hunter2');
    expect(copy.url).toBe('https://eth.provider.example/<redacted>');
    expect(copy.body).toEqual({
      method: 'eth_getLogs',
      params: ['https://eth.provider.example/<redacted>'],
    });
    expect(copy.status).toBe(429);
    const cause = copy.cause as AggregateError;
    expect(cause.name).toBe('AggregateError');
    expect((cause.errors[0] as Error).message).not.toContain('hunter2');
  });

  it('keeps the error name, so logs still show the type', () => {
    const err = new TypeError(`bad ${URL_WITH_KEY}`);
    expect((redactRpcUrl(err, URL_WITH_KEY) as Error).name).toBe('TypeError');
  });

  it('does not change the original error', () => {
    const err = new Error(URL_WITH_KEY);
    redactRpcUrl(err, URL_WITH_KEY);
    expect(err.message).toBe(URL_WITH_KEY);
  });

  it('redacts the query string and userinfo, encoded or not', () => {
    const url = 'https://user%40x:p%40ss-hunter2@rpc.example/?apikey=hunter3';
    const text = `a ${url} b p@ss-hunter2 c ?apikey=hunter3`;
    const message = (redactRpcUrl(new Error(text), url) as Error).message;
    expect(message).not.toMatch(/hunter2|hunter3/);
    expect(message).toContain('rpc.example');
  });

  it('leaves a URL with no path or userinfo as it is (the host is not secret)', () => {
    const url = 'http://localhost:8545';
    expect((redactRpcUrl(new Error(`to ${url}`), url) as Error).message).toBe(`to ${url}`);
  });

  it('hides the whole value when it is not a URL', () => {
    expect(redactRpcUrl('error near not-a-url-hunter2', 'not-a-url-hunter2')).toBe(
      'error near <redacted>',
    );
  });

  it('handles a cause cycle', () => {
    const a = new Error(`a ${URL_WITH_KEY}`);
    const b = new Error('b', { cause: a });
    a.cause = b;
    const copy = redactRpcUrl(a, URL_WITH_KEY) as Error;
    expect(((copy.cause as Error).cause as Error) === copy).toBe(true);
  });

  it('redacts the path when it appears without the host or the query', () => {
    const url = `${URL_WITH_KEY}?network=mainnet`;
    const message = (redactRpcUrl(new Error('POST /v2/key-hunter2 failed'), url) as Error).message;
    expect(message).toBe('POST /<redacted> failed');
  });

  it('redacts the path as typed, when the parser would encode it', () => {
    const url = 'https://rpc.example/v2/kéy hunter2';
    expect(new URL(url).pathname).toBe('/v2/k%C3%A9y%20hunter2');
    const message = (redactRpcUrl(new Error(`to ${url}`), url) as Error).message;
    expect(message).toBe('to https://rpc.example/<redacted>');
  });

  it('does not throw on a malformed escape in the userinfo', () => {
    const url = 'https://key%zz-hunter2@rpc.example/';
    expect((redactRpcUrl(new Error(url), url) as Error).message).not.toContain('hunter2');
  });

  it('passes non-error values through', () => {
    expect(redactRpcUrl(42, URL_WITH_KEY)).toBe(42);
    expect(redactRpcUrl(undefined, URL_WITH_KEY)).toBeUndefined();
  });
});
