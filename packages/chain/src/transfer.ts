import { type Address, decodeEventLog, type Hex } from 'viem';

import { normalizeAddress } from './address.js';

/** The ERC-20 `Transfer` event. `value` is not indexed, so it is in the log data. */
export const transferEventAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** `keccak256("Transfer(address,address,uint256)")`, the first topic of every Transfer log. */
export const TRANSFER_TOPIC: Hex =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** The decoded fields of one Transfer log. Addresses are lowercase, as they are stored. */
export type DecodedTransfer = {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
};

/** The raw log fields the decoder needs, as `eth_getLogs` returns them. */
export type RawTransferLog = {
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

/** A log that is not a standard ERC-20 Transfer. Never retryable: the same log fails again. */
export class InvalidTransferLogError extends Error {
  constructor(reason: string) {
    super(`Not an ERC-20 Transfer log: ${reason}`);
    this.name = 'InvalidTransferLogError';
  }
}

/** A 32-byte topic holding an address: 12 zero bytes, then 20 address bytes. */
const ADDRESS_TOPIC = /^0x0{24}[0-9a-fA-F]{40}$/;

/** One 32-byte ABI word, as the `uint256 value` is encoded in the data. */
const ONE_WORD = /^0x[0-9a-fA-F]{64}$/;

/**
 * Decodes one Transfer log, or throws `InvalidTransferLogError`. Never returns partial fields
 * and never skips a log, because a skipped log is a gap (docs/03 "No gaps").
 *
 * The shape is checked exactly, because viem's decoder is lenient here: it ignores extra topics
 * and extra data, and it keeps only the low 20 bytes of an address topic. An ERC-721 Transfer
 * has the same first topic but 4 topics; Solidity always emits address topics with zero high
 * bytes. After these checks, every input decodes.
 */
export function decodeTransferLog(log: RawTransferLog): DecodedTransfer {
  const [signature, fromTopic, toTopic, ...extraTopics] = log.topics;
  if (signature !== TRANSFER_TOPIC) {
    throw new InvalidTransferLogError('the first topic is not the Transfer signature');
  }
  if (fromTopic === undefined || toTopic === undefined || extraTopics.length > 0) {
    throw new InvalidTransferLogError(`expected 3 topics, got ${log.topics.length}`);
  }
  if (!ADDRESS_TOPIC.test(fromTopic) || !ADDRESS_TOPIC.test(toTopic)) {
    throw new InvalidTransferLogError('an address topic is not a zero-padded address');
  }
  if (!ONE_WORD.test(log.data)) {
    throw new InvalidTransferLogError('the data is not exactly one 32-byte value');
  }

  const { args } = decodeEventLog({
    abi: transferEventAbi,
    topics: [signature, fromTopic, toTopic],
    data: log.data,
    strict: true,
  });
  return {
    from: normalizeAddress(args.from),
    to: normalizeAddress(args.to),
    value: args.value,
  };
}
