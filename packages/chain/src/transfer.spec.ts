import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  maxUint256,
  pad,
  toEventSelector,
  zeroAddress,
} from 'viem';
import { describe, expect, it } from 'vitest';

import {
  decodeTransferLog,
  InvalidTransferLogError,
  TRANSFER_TOPIC,
  transferEventAbi,
} from './transfer.js';

// anvil accounts 0 and 1, checksummed, so the test proves the output is lowercase.
const ALICE: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function transferLog(from: Address, to: Address, value: bigint) {
  return {
    // Every topic is set here, so none is null or a list of alternatives (those are for filters).
    topics: encodeEventTopics({
      abi: transferEventAbi,
      eventName: 'Transfer',
      args: { from, to },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

describe('TRANSFER_TOPIC', () => {
  it('is the selector of the ABI event', () => {
    expect(toEventSelector('Transfer(address,address,uint256)')).toBe(TRANSFER_TOPIC);
    expect(toEventSelector(transferEventAbi[0])).toBe(TRANSFER_TOPIC);
  });
});

describe('decodeTransferLog', () => {
  it('decodes from, to and value, with lowercase addresses', () => {
    expect(decodeTransferLog(transferLog(ALICE, BOB, 1_000n))).toEqual({
      from: ALICE.toLowerCase(),
      to: BOB.toLowerCase(),
      value: 1_000n,
    });
  });

  it('decodes a mint (from the zero address) like any other transfer', () => {
    expect(decodeTransferLog(transferLog(zeroAddress, BOB, 1n)).from).toBe(zeroAddress);
  });

  it('keeps values above 2^53 and up to 2^256-1 exact', () => {
    expect(decodeTransferLog(transferLog(ALICE, BOB, 2n ** 53n + 1n)).value).toBe(2n ** 53n + 1n);
    expect(decodeTransferLog(transferLog(ALICE, BOB, maxUint256)).value).toBe(maxUint256);
  });

  it('decodes a zero-value transfer', () => {
    expect(decodeTransferLog(transferLog(ALICE, BOB, 0n)).value).toBe(0n);
  });

  describe('rejects a log that is not a standard ERC-20 Transfer', () => {
    const valid = transferLog(ALICE, BOB, 5n);
    const [, fromTopic, toTopic] = valid.topics;
    const approvalTopic = toEventSelector('Approval(address,address,uint256)');
    // viem would decode this as ALICE: it keeps only the low 20 bytes.
    const dirtyFrom: Hex = `0x${'ff'.repeat(12)}${ALICE.slice(2).toLowerCase()}`;

    it.each<[string, Hex[], Hex, string]>([
      ['no topics', [], valid.data, 'the first topic'],
      [
        'another event (Approval)',
        [approvalTopic, fromTopic!, toTopic!],
        valid.data,
        'the first topic',
      ],
      ['only 2 topics', [TRANSFER_TOPIC, fromTopic!], valid.data, 'expected 3 topics, got 2'],
      // ERC-721 Transfer: same first topic, tokenId indexed as a 4th topic, empty data.
      ['an ERC-721 Transfer', [...valid.topics, pad('0x7')], '0x', 'expected 3 topics, got 4'],
      ['4 topics with data', [...valid.topics, pad('0x7')], valid.data, 'expected 3 topics, got 4'],
      [
        'dirty high bytes in from',
        [TRANSFER_TOPIC, dirtyFrom, toTopic!],
        valid.data,
        'address topic',
      ],
      [
        'dirty high bytes in to',
        [TRANSFER_TOPIC, fromTopic!, dirtyFrom],
        valid.data,
        'address topic',
      ],
      ['a short address topic', [TRANSFER_TOPIC, ALICE, toTopic!], valid.data, 'address topic'],
      ['empty data', valid.topics, '0x', 'one 32-byte value'],
      [
        'extra data after the value',
        valid.topics,
        `${valid.data}${'00'.repeat(32)}`,
        'one 32-byte value',
      ],
      ['a short value', valid.topics, '0x05', 'one 32-byte value'],
      ['non-hex data', valid.topics, `0x${'zz'.repeat(32)}`, 'one 32-byte value'],
    ])('%s', (_label, topics, data, reason) => {
      expect(() => decodeTransferLog({ topics, data })).toThrow(InvalidTransferLogError);
      expect(() => decodeTransferLog({ topics, data })).toThrow(reason);
    });
  });
});
