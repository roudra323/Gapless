import { RPC_BATCH_SIZE, TRANSFER_TOPIC } from '@gapless/chain';
import type { NewTransferRow } from '@gapless/db';
import { type Address, type Hex, hexToBigInt, numberToHex, type PublicClient } from 'viem';

import { AnchorMismatchError } from './ingestion-errors.js';
import { type BlockHeader, toBlockHeader, toTransferRows } from './range-consistency.js';
import type { BlockRange } from './range-planner.js';

export type FetchRangeInput = {
  readonly range: BlockRange;
  /** The checkpoint: the range must build on this block (docs/03 "Reorg guard"). */
  readonly anchor: { readonly block: bigint; readonly hash: Hex };
  readonly chainId: number;
  /** Lowercase, from the config. */
  readonly tokenAddress: Address;
};

export type FetchedRange = {
  /** The chain's hash of `range.to`, the next `last_block_hash`. */
  readonly toHash: Hex;
  readonly rows: readonly NewTransferRow[];
};

function getHeader(client: PublicClient, block: bigint) {
  return client.request({ method: 'eth_getBlockByNumber', params: [numberToHex(block), false] });
}

/**
 * Fetches one range and checks it (docs/03 "Ingestion loop" and "RPC consistency checks").
 *
 * The anchor header, the `to` header and `eth_getLogs` are requested in the same tick, so the
 * HTTP transport sends them in one JSON-RPC batch and, on most providers, one node answers all
 * three. Then the headers of the other log blocks are fetched in sequential POSTs of at most
 * `RPC_BATCH_SIZE` calls.
 *
 * The logs are fetched with raw `eth_getLogs` and decoded by `decodeTransferLog`. Never use
 * viem's `getLogs` here: with `strict: false` it returns a log that does not decode with partial
 * args, and with `strict: true` it drops it. Both hide a bad log.
 *
 * Throws `AnchorMismatchError` on a reorg, `RangeInconsistentError` when a check fails,
 * `InvalidTransferLogError` for a non-Transfer log, and viem errors for a failed request.
 */
export async function fetchRange(
  client: PublicClient,
  { range, anchor, chainId, tokenAddress }: FetchRangeInput,
): Promise<FetchedRange> {
  const [anchorBlock, toBlock, logs] = await Promise.all([
    getHeader(client, anchor.block),
    getHeader(client, range.to),
    client.request({
      method: 'eth_getLogs',
      params: [
        {
          address: tokenAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock: numberToHex(range.from),
          toBlock: numberToHex(range.to),
        },
      ],
    }),
  ]);

  const anchorHeader = toBlockHeader(anchorBlock, anchor.block);
  if (anchorHeader.hash !== anchor.hash) {
    throw new AnchorMismatchError(anchor.block, anchor.hash, anchorHeader.hash);
  }
  const toHeader = toBlockHeader(toBlock, range.to);

  const headers = new Map<bigint, BlockHeader>([[toHeader.number, toHeader]]);
  const missing = [
    ...new Set(
      logs.flatMap((log) => (log.blockNumber === null ? [] : [hexToBigInt(log.blockNumber)])),
    ),
  ].filter((block) => !headers.has(block));
  for (let start = 0; start < missing.length; start += RPC_BATCH_SIZE) {
    const chunk = missing.slice(start, start + RPC_BATCH_SIZE);
    // One chunk per POST, one POST at a time: no unbounded fan-out (docs/05 "Async").
    const blocks = await Promise.all(chunk.map((block) => getHeader(client, block)));
    for (const [i, block] of blocks.entries()) {
      const header = toBlockHeader(block, chunk[i] as bigint);
      headers.set(header.number, header);
    }
  }

  return {
    toHash: toHeader.hash,
    rows: toTransferRows({ logs, headers, range, chainId, tokenAddress }),
  };
}
