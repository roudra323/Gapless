/**
 * One indexed ERC-20 transfer, in the API's own terms. The repository returns this type, never a
 * raw Drizzle row (docs/05 "NestJS structure"). Addresses and hashes are lowercase, as stored.
 */
export type Transfer = {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
};

/** Which side of a transfer an address is on, for `/v1/addresses/:address/transfers`. */
export const DIRECTIONS = ['in', 'out', 'all'] as const;
export type Direction = (typeof DIRECTIONS)[number];
