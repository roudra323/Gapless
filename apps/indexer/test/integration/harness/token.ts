import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

/** anvil's well-known account 0 (a public test key, funded on every anvil chain). */
const ANVIL_KEY_0: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const ARTIFACT = join(
  import.meta.dirname,
  '../../../../../contracts/out/MockToken.sol/MockToken.json',
);

type Artifact = { readonly abi: Abi; readonly bytecode: { readonly object: Hex } };

async function readArtifact(): Promise<Artifact> {
  try {
    return JSON.parse(await readFile(ARTIFACT, 'utf8')) as Artifact;
  } catch (err) {
    throw new Error(
      `MockToken artifact not found at ${ARTIFACT}: run "forge build" in contracts/`,
      {
        cause: err,
      },
    );
  }
}

/** A deterministic PRNG (mulberry32), so a test spreads its transfers the same way every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type SendTransfersOptions = {
  /** Each mined block holds between 1 and this many transfers. */
  readonly perBlockMax: number;
  readonly random: () => number;
};

export type TestToken = {
  readonly address: Address;
  /** The block after the latest block at deploy time, as the deploy script prints it. */
  readonly startBlock: bigint;
  readonly publicClient: PublicClient;
  /**
   * Mines `count` transfers from account 0 in blocks of random size. Returns the last block
   * mined. Automine is off while it runs, so the test controls the blocks.
   */
  readonly sendTransfers: (count: number, options: SendTransfersOptions) => Promise<bigint>;
  /** Mines `blocks` empty blocks (to pass the confirmations). */
  readonly mine: (blocks: number) => Promise<bigint>;
};

/**
 * Deploys `MockToken` from its `forge build` artifact and mints a supply to account 0 (one
 * Transfer from the zero address).
 */
export async function deployMockToken(rpcUrl: string): Promise<TestToken> {
  const { abi, bytecode } = await readArtifact();
  const account = privateKeyToAccount(ANVIL_KEY_0);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: foundry, transport, cacheTime: 0 });
  const wallet = createWalletClient({ account, chain: foundry, transport });
  const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport });

  const startBlock = (await publicClient.getBlockNumber()) + 1n;
  const deployHash = await wallet.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [account.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
    throw new Error('MockToken deployment returned no contract address');
  }
  const address = receipt.contractAddress;

  const mintHash = await wallet.writeContract({
    address,
    abi,
    functionName: 'mint',
    args: [account.address, 10n ** 30n],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const recipients = Array.from(
    { length: 10 },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
  );

  const mine = async (blocks: number): Promise<bigint> => {
    await testClient.mine({ blocks });
    return publicClient.getBlockNumber();
  };

  const sendTransfers = async (
    count: number,
    { perBlockMax, random }: SendTransfersOptions,
  ): Promise<bigint> => {
    let nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });
    await testClient.setAutomine(false);
    try {
      let sent = 0;
      while (sent < count) {
        const inBlock = Math.min(count - sent, 1 + Math.floor(random() * perBlockMax));
        for (let i = 0; i < inBlock; i++) {
          // A fixed gas limit and an explicit nonce: no estimate against a block not mined yet.
          await wallet.writeContract({
            address,
            abi,
            functionName: 'transfer',
            args: [
              recipients[(sent + i) % recipients.length],
              BigInt(1 + Math.floor(random() * 1e6)),
            ],
            nonce: nonce++,
            gas: 100_000n,
          });
        }
        sent += inBlock;
        await testClient.mine({ blocks: 1 });
      }
    } finally {
      await testClient.setAutomine(true);
    }
    return publicClient.getBlockNumber();
  };

  return { address, startBlock, publicClient, sendTransfers, mine };
}
