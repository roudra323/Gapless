import { TRANSFER_TOPIC } from '@gapless/chain';
import { type Address, hexToNumber, numberToHex, type PublicClient } from 'viem';

import type { TransferKey } from '../ingestion/indexer.repository.js';

/** At most this many keys of each kind go into a report, so a large mismatch stays readable. */
export const MAX_REPORTED_KEYS = 20;

export type ParityReport = {
  readonly from: bigint;
  readonly to: bigint;
  readonly chainCount: number;
  readonly dbCount: number;
  /** On chain, not in the DB: gaps. */
  readonly missing: readonly string[];
  /** In the DB, not on chain (for example rows of an old fork). */
  readonly unexpected: readonly string[];
  /** Keys returned more than once by the chain (overlapping chunks would show up here). */
  readonly duplicates: readonly string[];
  readonly ok: boolean;
};

/** `txHash:logIndex`, lowercase, the same form for both sides. */
export function keyOf({ txHash, logIndex }: TransferKey): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

/**
 * Compares the keys from `getLogs` with the keys in the DB. Parity means no gaps and no
 * duplicates (docs/06 "parity assertion"): the same set on both sides, each key once.
 */
export function compareKeys(
  range: { readonly from: bigint; readonly to: bigint },
  chainKeys: readonly string[],
  dbKeys: readonly string[],
): ParityReport {
  const chain = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of chainKeys) {
    if (chain.has(key)) duplicates.add(key);
    chain.add(key);
  }
  const db = new Set(dbKeys);
  // The DB primary key makes duplicates there impossible; count them anyway to prove it.
  const dbDuplicates = dbKeys.length - db.size;
  const missing = [...chain].filter((key) => !db.has(key));
  const unexpected = [...db].filter((key) => !chain.has(key));
  return {
    // Only the two numbers: `range` may be the whole verify input, with the client and the pool.
    from: range.from,
    to: range.to,
    chainCount: chainKeys.length,
    dbCount: dbKeys.length,
    missing: missing.slice(0, MAX_REPORTED_KEYS),
    unexpected: unexpected.slice(0, MAX_REPORTED_KEYS),
    duplicates: [...duplicates].slice(0, MAX_REPORTED_KEYS),
    ok:
      missing.length === 0 &&
      unexpected.length === 0 &&
      duplicates.size === 0 &&
      dbDuplicates === 0,
  };
}

export type VerifyRangeInput = {
  readonly client: PublicClient;
  readonly store: { readonly transferKeys: (from: bigint, to: bigint) => Promise<TransferKey[]> };
  /** Lowercase, from the config. */
  readonly tokenAddress: Address;
  readonly from: bigint;
  readonly to: bigint;
  /** Blocks per `eth_getLogs` call. */
  readonly chunkSize: bigint;
};

/**
 * The keys of every Transfer log of the token in `from`–`to`, straight from `eth_getLogs`, in
 * sequential chunks. It shares no code with the ingestion path on purpose, so a bug there can't
 * hide itself here.
 */
async function fetchChainKeys({
  client,
  tokenAddress,
  from,
  to,
  chunkSize,
}: Omit<VerifyRangeInput, 'store'>): Promise<string[]> {
  const keys: string[] = [];
  for (let start = from; start <= to; start += chunkSize) {
    const end = start + chunkSize - 1n < to ? start + chunkSize - 1n : to;
    const logs = await client.request({
      method: 'eth_getLogs',
      params: [
        {
          address: tokenAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock: numberToHex(start),
          toBlock: numberToHex(end),
        },
      ],
    });
    for (const log of logs) {
      if (log.removed || log.transactionHash === null || log.logIndex === null) {
        throw new Error(`eth_getLogs returned a removed or pending log in ${start}-${end}`);
      }
      keys.push(keyOf({ txHash: log.transactionHash, logIndex: hexToNumber(log.logIndex) }));
    }
  }
  return keys;
}

/** Compares the chain and the DB for one block range (docs/03 "Verification tool"). */
export async function verifyRange(input: VerifyRangeInput): Promise<ParityReport> {
  if (input.chunkSize < 1n) throw new RangeError('chunkSize must be at least 1');
  if (input.to < input.from) throw new RangeError(`empty range ${input.from}-${input.to}`);
  const [onChain, stored] = await Promise.all([
    fetchChainKeys(input),
    input.store.transferKeys(input.from, input.to),
  ]);
  return compareKeys(input, onChain, stored.map(keyOf));
}
