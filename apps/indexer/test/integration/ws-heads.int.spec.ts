import { subscribeNewHeads } from '@gapless/chain';
import { createTestClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvil, type TestAnvil } from './harness/anvil.js';
import { startTcpProxy, type TcpProxy } from './harness/tcp-proxy.js';
import { waitFor } from './harness/wait-for.js';

let anvil: TestAnvil;
let proxy: TcpProxy;

beforeAll(async () => {
  anvil = await startAnvil();
  proxy = await startTcpProxy(anvil.rpcUrl);
});

afterAll(async () => {
  await proxy?.close();
  await anvil?.stop();
});

async function mine(blocks: number): Promise<void> {
  await createTestClient({ mode: 'anvil', chain: foundry, transport: http(anvil.rpcUrl) }).mine({
    blocks,
  });
}

describe('subscribeNewHeads (anvil)', () => {
  it('delivers each new head, and reports a dropped socket once', async () => {
    const heads: bigint[] = [];
    const errors: unknown[] = [];
    const subscription = await subscribeNewHeads({
      url: `ws://${proxy.address}`,
      onHead: (block) => heads.push(block),
      onError: (err) => errors.push(err),
    });

    await mine(3);
    await waitFor(() => heads.length >= 3, { timeoutMs: 5000, description: '3 heads' });
    expect(heads.slice(-3).map((b, i, all) => b - (all[0] ?? 0n))).toEqual([0n, 1n, 2n]);

    proxy.dropAll();
    await waitFor(() => errors.length > 0, { timeoutMs: 5000, description: 'socket error' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toHaveLength(1);
    await subscription.close();
  });

  it('opens a new socket after a close, on the same URL', async () => {
    const url = `ws://${proxy.address}`;
    const first = await subscribeNewHeads({
      url,
      onHead: () => undefined,
      onError: () => undefined,
    });
    await first.close();

    const heads: bigint[] = [];
    const second = await subscribeNewHeads({
      url,
      onHead: (block) => heads.push(block),
      onError: () => undefined,
    });
    await mine(1);
    await waitFor(() => heads.length === 1, { timeoutMs: 5000, description: 'a head' });
    await second.close();
  });

  it('rejects when the socket cannot be opened', async () => {
    proxy.pause();
    try {
      await expect(
        subscribeNewHeads({
          url: `ws://${proxy.address}`,
          onHead: () => undefined,
          onError: () => undefined,
        }),
      ).rejects.toThrow();
    } finally {
      proxy.resume();
    }
  });
});
