import { type Address, hexToBigInt, keccak256, slice, toBytes } from 'viem';

/**
 * The Postgres advisory-lock key for one chain and token (docs/03 "Leader"): the first 8 bytes of
 * `keccak256("gapless:indexer:<chainId>:<token>")` as a signed 64-bit integer, the type
 * `pg_try_advisory_lock(bigint)` takes. The `gapless:indexer:` prefix keeps it apart from locks
 * that other software may take in the same database.
 */
export function advisoryLockKey(chainId: number, tokenAddress: Address): bigint {
  const digest = keccak256(toBytes(`gapless:indexer:${chainId}:${tokenAddress.toLowerCase()}`));
  return hexToBigInt(slice(digest, 0, 8), { signed: true });
}
