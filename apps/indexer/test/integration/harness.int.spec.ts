import { TRANSFER_TOPIC } from '@gapless/chain';
import { numberToHex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvil, type TestAnvil } from './harness/anvil.js';
import { deployMockToken, seededRandom, type TestToken } from './harness/token.js';

let anvil: TestAnvil;
let token: TestToken;

beforeAll(async () => {
  anvil = await startAnvil();
  token = await deployMockToken(anvil.rpcUrl);
});

afterAll(async () => {
  await anvil?.stop();
});

describe('integration harness', () => {
  it('deploys the token, mints, and mines transfers in blocks of random size', async () => {
    const before = await token.publicClient.getBlockNumber();
    const last = await token.sendTransfers(30, { perBlockMax: 5, random: seededRandom(1) });

    const logs = await token.publicClient.request({
      method: 'eth_getLogs',
      params: [
        {
          address: token.address,
          topics: [TRANSFER_TOPIC],
          fromBlock: numberToHex(token.startBlock),
          toBlock: numberToHex(last),
        },
      ],
    });
    expect(logs).toHaveLength(31); // the mint + 30 transfers

    const blocks = new Set(
      logs.filter((log) => BigInt(log.blockNumber ?? '0x0') > before).map((l) => l.blockNumber),
    );
    // At most 5 per block, so at least 6 blocks; more than 1 per block on average.
    expect(blocks.size).toBeGreaterThanOrEqual(6);
    expect(blocks.size).toBeLessThan(30);
    expect(last - before).toBe(BigInt(blocks.size));
  });

  it('mines empty blocks', async () => {
    const before = await token.publicClient.getBlockNumber();
    expect(await token.mine(3)).toBe(before + 3n);
  });
});
