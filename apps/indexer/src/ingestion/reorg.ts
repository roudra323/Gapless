import type { Hex } from 'viem';

/** The newest stored transfer block at or below some block, with the hash stored on its row. */
export type StoredBlock = {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
};

export type FindRewindTargetInput = {
  /** The checkpoint's `last_block`, whose hash no longer matches the chain. */
  readonly lastBlock: bigint;
  /** `REORG_REWIND_BLOCKS`: the minimum rewind depth. */
  readonly rewindBlocks: bigint;
  readonly startBlock: bigint;
  /** The newest stored transfer block `<= block` for this chain and token, or `null`. */
  readonly newestStoredAtOrBelow: (block: bigint) => Promise<StoredBlock | null>;
  /** The chain's current hash of `block`. */
  readonly chainHashOf: (block: bigint) => Promise<Hex>;
};

export type RewindTarget = {
  /** The new `last_block`: every block up to it is proven canonical. */
  readonly rewindTo: bigint;
  /** The chain's hash of `rewindTo`, the new `last_block_hash`. */
  readonly rewindHash: Hex;
};

/**
 * Finds the block to rewind to after a reorg (docs/03 "Reorg guard").
 *
 * It starts at `lastBlock - rewindBlocks` and walks back over the stored transfer blocks until
 * one still has the chain's hash. A block hash commits to its parent, so that block and all
 * blocks below it are canonical. Stopping at the candidate without that proof could skip
 * transfers of a reorg deeper than `rewindBlocks` (a gap). With no matching row, it rewinds to
 * `startBlock - 1`, the seed.
 */
export async function findRewindTarget({
  lastBlock,
  rewindBlocks,
  startBlock,
  newestStoredAtOrBelow,
  chainHashOf,
}: FindRewindTargetInput): Promise<RewindTarget> {
  const floor = startBlock - 1n;
  let candidate = lastBlock - rewindBlocks;

  while (candidate > floor) {
    const stored = await newestStoredAtOrBelow(candidate);
    if (stored === null || stored.blockNumber <= floor) break;
    const chainHash = await chainHashOf(stored.blockNumber);
    if (chainHash === stored.blockHash) {
      return { rewindTo: stored.blockNumber, rewindHash: chainHash };
    }
    candidate = stored.blockNumber - 1n;
  }
  return { rewindTo: floor, rewindHash: await chainHashOf(floor) };
}
