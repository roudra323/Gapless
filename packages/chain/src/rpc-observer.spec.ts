import { describe, expect, it } from 'vitest';

import { observeRpcCall, type RpcCall } from './rpc-observer.js';

describe('observeRpcCall', () => {
  it('passes the value through and reports ok', async () => {
    const calls: RpcCall[] = [];
    const value = await observeRpcCall(
      (call) => calls.push(call),
      'eth_chainId',
      'ws',
      () => Promise.resolve(7),
    );
    expect(value).toBe(7);
    expect(calls).toEqual([
      { method: 'eth_chainId', transport: 'ws', result: 'ok', durationSeconds: expect.any(Number) },
    ]);
  });

  it('rethrows the same error and reports error', async () => {
    const calls: RpcCall[] = [];
    const boom = new Error('boom');
    await expect(
      observeRpcCall(
        (call) => calls.push(call),
        'eth_subscribe',
        'ws',
        () => Promise.reject(boom),
      ),
    ).rejects.toBe(boom);
    expect(calls.map((call) => call.result)).toEqual(['error']);
  });

  it('runs the call alone without an observer', async () => {
    expect(await observeRpcCall(undefined, 'eth_chainId', 'http', () => Promise.resolve(1))).toBe(
      1,
    );
  });
});
