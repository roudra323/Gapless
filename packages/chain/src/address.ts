import { type Address, getAddress, InvalidAddressError, isAddress } from 'viem';

/**
 * Throws unless `value` is an all-lowercase or EIP-55 checksummed address. A mixed-case address
 * with a wrong checksum is rejected, because that is usually a typo. (viem's `getAddress` alone
 * accepts it and silently "fixes" the checksum.)
 */
function assertAddress(value: string): asserts value is Address {
  if (!isAddress(value)) throw new InvalidAddressError({ address: value });
}

/** The lowercase form, used for storage and comparison (docs/05 "Blockchain values"). */
export function normalizeAddress(value: string): Address {
  assertAddress(value);
  return value.toLowerCase() as Address;
}

/** The EIP-55 checksummed form, used in API responses (docs/05 "Blockchain values"). */
export function toChecksum(value: string): Address {
  assertAddress(value);
  return getAddress(value);
}
