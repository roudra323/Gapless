import { decodeTransferLog, normalizeAddress } from '@gapless/chain';
import type { NewTransferRow } from '@gapless/db';
import { type Address, type Hex, hexToBigInt, hexToNumber, type RpcBlock, type RpcLog } from 'viem';

import { RangeInconsistentError } from './ingestion-errors.js';
import type { BlockRange } from './range-planner.js';

/** The header fields the indexer uses. The hash is lowercase, as it is stored. */
export type BlockHeader = {
  readonly number: bigint;
  readonly hash: Hex;
  /** Seconds since the Unix epoch. */
  readonly timestamp: bigint;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

function lowerHash(value: string | null | undefined, field: string): Hex {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new RangeInconsistentError(`${field} is not a 32-byte hash`);
  }
  return value.toLowerCase() as Hex;
}

function quantity(value: string | null | undefined, field: string): Hex {
  if (typeof value !== 'string' || !QUANTITY.test(value)) {
    throw new RangeInconsistentError(`${field} is missing or not a hex quantity`);
  }
  return value as Hex;
}

/**
 * Checks one `eth_getBlockByNumber` answer. A `null` block means the node that answered does not
 * have it yet (it is behind), so the range must be tried again later.
 */
export function toBlockHeader(block: RpcBlock | null, expectedNumber: bigint): BlockHeader {
  if (block === null) {
    throw new RangeInconsistentError(`block ${expectedNumber} is not available on the node`);
  }
  const number = hexToBigInt(quantity(block.number, `block ${expectedNumber} number`));
  if (number !== expectedNumber) {
    throw new RangeInconsistentError(`asked for block ${expectedNumber}, got block ${number}`);
  }
  return {
    number,
    hash: lowerHash(block.hash, `block ${expectedNumber} hash`),
    timestamp: hexToBigInt(quantity(block.timestamp, `block ${expectedNumber} timestamp`)),
  };
}

export type ToTransferRowsInput = {
  readonly logs: readonly RpcLog[];
  /** The header of every block that has a log, by block number. */
  readonly headers: ReadonlyMap<bigint, BlockHeader>;
  readonly range: BlockRange;
  readonly chainId: number;
  /** Lowercase, from the config. */
  readonly tokenAddress: Address;
};

/**
 * Turns the raw `eth_getLogs` answer for a range into rows, or throws.
 *
 * - `RangeInconsistentError` (retryable) when the answer is not consistent: a removed or pending
 *   log, a log outside the range or from another address, or a log whose `blockHash` differs from
 *   the header fetched for its block (docs/03 "RPC consistency checks").
 * - `InvalidTransferLogError` (not retryable) when a log is not a standard Transfer.
 */
export function toTransferRows({
  logs,
  headers,
  range,
  chainId,
  tokenAddress,
}: ToTransferRowsInput): NewTransferRow[] {
  return logs.map((log) => {
    if (log.removed) throw new RangeInconsistentError('a log is marked removed');
    const blockNumber = hexToBigInt(quantity(log.blockNumber, 'log blockNumber'));
    if (blockNumber < range.from || blockNumber > range.to) {
      throw new RangeInconsistentError(
        `a log in block ${blockNumber} is outside ${range.from}-${range.to}`,
      );
    }
    if (normalizeAddress(log.address) !== tokenAddress) {
      throw new RangeInconsistentError(`a log in block ${blockNumber} is from another address`);
    }
    const header = headers.get(blockNumber);
    if (header === undefined) {
      throw new RangeInconsistentError(`no header for log block ${blockNumber}`);
    }
    const blockHash = lowerHash(log.blockHash, `log blockHash in block ${blockNumber}`);
    if (blockHash !== header.hash) {
      throw new RangeInconsistentError(
        `a log in block ${blockNumber} has hash ${blockHash}, the header has ${header.hash}`,
      );
    }

    const { from, to, value } = decodeTransferLog(log);
    return {
      chainId,
      blockNumber,
      blockHash,
      blockTimestamp: new Date(Number(header.timestamp) * 1000),
      txHash: lowerHash(log.transactionHash, `log transactionHash in block ${blockNumber}`),
      logIndex: hexToNumber(quantity(log.logIndex, `log logIndex in block ${blockNumber}`)),
      tokenAddress,
      fromAddress: from,
      toAddress: to,
      value,
    };
  });
}
