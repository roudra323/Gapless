import { type Hex, numberToHex, pad } from 'viem';
import { describe, expect, it } from 'vitest';

import { findRewindTarget, type StoredBlock } from './reorg.js';

function hash(n: number, fork = 0): Hex {
  return pad(numberToHex(n + fork * 1_000_000), { size: 32 });
}

/**
 * A store with transfers in `storedBlocks` (all hashed on fork 0), and a chain on which every
 * block above `forkedAbove` now has a fork-1 hash.
 */
function setup(storedBlocks: readonly number[], forkedAbove: number) {
  const asked: bigint[] = [];
  const sorted = storedBlocks.toSorted((a, b) => b - a);
  const newestStoredAtOrBelow = (block: bigint): Promise<StoredBlock | null> => {
    const found = sorted.find((b) => BigInt(b) <= block);
    return Promise.resolve(
      found === undefined ? null : { blockNumber: BigInt(found), blockHash: hash(found) },
    );
  };
  const chainHashOf = (block: bigint): Promise<Hex> => {
    asked.push(block);
    const n = Number(block);
    return Promise.resolve(n > forkedAbove ? hash(n, 1) : hash(n));
  };
  return { newestStoredAtOrBelow, chainHashOf, asked };
}

describe('findRewindTarget', () => {
  it('rewinds to the newest stored block at or below the candidate when it still matches', async () => {
    // Reorg of the top 2 blocks; the candidate (100 - 10 = 90) has a row that matches.
    const ports = setup([50, 80, 90, 99], 98);
    expect(
      await findRewindTarget({ lastBlock: 100n, rewindBlocks: 10n, startBlock: 1n, ...ports }),
    ).toEqual({ rewindTo: 90n, rewindHash: hash(90) });
  });

  it('walks back past rows that no longer match (a reorg deeper than the rewind depth)', async () => {
    // Everything above 60 changed; the rows at 85 and 70 mismatch, 60 is the first proven block.
    const ports = setup([40, 60, 70, 85, 95], 60);
    expect(
      await findRewindTarget({ lastBlock: 100n, rewindBlocks: 10n, startBlock: 1n, ...ports }),
    ).toEqual({ rewindTo: 60n, rewindHash: hash(60) });
    expect(ports.asked).toEqual([85n, 70n, 60n]);
  });

  it('rewinds to START_BLOCK - 1 when no stored row matches', async () => {
    const ports = setup([20, 30], 5);
    expect(
      await findRewindTarget({ lastBlock: 100n, rewindBlocks: 10n, startBlock: 11n, ...ports }),
    ).toEqual({ rewindTo: 10n, rewindHash: hash(10, 1) });
  });

  it('rewinds to START_BLOCK - 1 when there are no rows at all', async () => {
    const ports = setup([], 0);
    expect(
      await findRewindTarget({ lastBlock: 100n, rewindBlocks: 10n, startBlock: 5n, ...ports }),
    ).toEqual({ rewindTo: 4n, rewindHash: hash(4, 1) });
  });

  it('never goes below START_BLOCK - 1, even when the depth is larger than the range', async () => {
    const ports = setup([3], 0);
    expect(
      await findRewindTarget({ lastBlock: 8n, rewindBlocks: 64n, startBlock: 5n, ...ports }),
    ).toEqual({ rewindTo: 4n, rewindHash: hash(4, 1) });
    // The row at block 3 is below the floor and is never compared.
    expect(ports.asked).toEqual([4n]);
  });

  it('accepts a matching row exactly at the candidate', async () => {
    const ports = setup([90], 90);
    expect(
      await findRewindTarget({ lastBlock: 100n, rewindBlocks: 10n, startBlock: 1n, ...ports }),
    ).toEqual({ rewindTo: 90n, rewindHash: hash(90) });
  });
});
