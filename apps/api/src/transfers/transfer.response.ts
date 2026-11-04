import { toChecksum } from '@gapless/chain';

import type { Transfer } from './transfer.js';

/** One transfer in a response body (docs/02 "API contract"). */
export type TransferResponse = {
  readonly txHash: string;
  readonly logIndex: number;
  /** A decimal string: block numbers are `bigint` (docs/05 "Blockchain values"). */
  readonly blockNumber: string;
  /** ISO 8601 in UTC. */
  readonly blockTimestamp: string;
  /** EIP-55 checksummed. */
  readonly from: string;
  /** EIP-55 checksummed. */
  readonly to: string;
  /** A decimal string: the full uint256, never a float. */
  readonly value: string;
};

/** A page of transfers. `nextCursor` is `null` on the last page. */
export type TransferPageResponse = {
  readonly data: readonly TransferResponse[];
  readonly nextCursor: string | null;
};

/** Maps a transfer to its response shape. Explicit, so a new DB column never leaks out. */
export function toTransferResponse(transfer: Transfer): TransferResponse {
  return {
    txHash: transfer.txHash,
    logIndex: transfer.logIndex,
    blockNumber: transfer.blockNumber.toString(),
    blockTimestamp: transfer.blockTimestamp.toISOString(),
    from: toChecksum(transfer.from),
    to: toChecksum(transfer.to),
    value: transfer.value.toString(),
  };
}
