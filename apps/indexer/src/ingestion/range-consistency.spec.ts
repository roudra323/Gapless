import { InvalidTransferLogError, TRANSFER_TOPIC } from '@gapless/chain';
import { type Address, type Hex, numberToHex, pad, type RpcBlock, type RpcLog } from 'viem';
import { describe, expect, it } from 'vitest';

import { RangeInconsistentError } from './ingestion-errors.js';
import { type BlockHeader, toBlockHeader, toTransferRows } from './range-consistency.js';

const TOKEN: Address = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const FROM: Address = '0x1111111111111111111111111111111111111111';
const TO: Address = '0x2222222222222222222222222222222222222222';
const MAX_UINT256 = 2n ** 256n - 1n;

function hash(n: number): Hex {
  return pad(numberToHex(n), { size: 32 });
}

/** The same hash in uppercase hex, as some nodes return it. */
function upper(hex: Hex): Hex {
  return `0x${hex.slice(2).toUpperCase()}`;
}

function header(number: bigint, overrides: Partial<BlockHeader> = {}): BlockHeader {
  return { number, hash: hash(Number(number)), timestamp: 1_767_225_600n + number, ...overrides };
}

function rpcLog(block: bigint, overrides: Partial<RpcLog> = {}): RpcLog {
  return {
    address: TOKEN,
    blockHash: hash(Number(block)),
    blockNumber: numberToHex(block),
    data: pad(numberToHex(5n), { size: 32 }),
    logIndex: '0x0',
    transactionHash: hash(1000 + Number(block)),
    transactionIndex: '0x0',
    topics: [TRANSFER_TOPIC, pad(FROM, { size: 32 }), pad(TO, { size: 32 })],
    removed: false,
    ...overrides,
  };
}

const range = { from: 10n, to: 20n };
const headers = new Map([10n, 15n, 20n].map((n) => [n, header(n)]));
const input = { headers, range, chainId: 31337, tokenAddress: TOKEN };

describe('toTransferRows', () => {
  it('maps a log to a row with lowercase values and the header timestamp', () => {
    const value = pad(numberToHex(MAX_UINT256), { size: 32 });
    const log = rpcLog(15n, {
      data: value,
      logIndex: '0x7',
      blockHash: upper(hash(15)),
      transactionHash: upper(hash(1015)),
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    });

    expect(toTransferRows({ ...input, logs: [log] })).toEqual([
      {
        chainId: 31337,
        blockNumber: 15n,
        blockHash: hash(15),
        blockTimestamp: new Date(Number(1_767_225_615n) * 1000),
        txHash: hash(1015),
        logIndex: 7,
        tokenAddress: TOKEN,
        fromAddress: FROM,
        toAddress: TO,
        value: MAX_UINT256,
      },
    ]);
  });

  it('returns no rows for no logs', () => {
    expect(toTransferRows({ ...input, logs: [] })).toEqual([]);
  });

  it.each([
    ['a removed log', rpcLog(15n, { removed: true }), /removed/],
    ['a pending log (no block number)', rpcLog(15n, { blockNumber: null }), /blockNumber/],
    ['a log below the range', rpcLog(9n), /outside 10-20/],
    ['a log above the range', rpcLog(21n), /outside 10-20/],
    [
      'a log from another address',
      rpcLog(15n, { address: '0x3333333333333333333333333333333333333333' }),
      /another address/,
    ],
    ['a log with no header', rpcLog(12n), /no header for log block 12/],
    ['a log from another fork', rpcLog(15n, { blockHash: hash(99) }), /has hash/],
    ['a pending log (no block hash)', rpcLog(15n, { blockHash: null }), /blockHash/],
    ['a log with no transaction hash', rpcLog(15n, { transactionHash: null }), /transaction/],
    ['a log with no log index', rpcLog(15n, { logIndex: null }), /logIndex/],
  ])('rejects %s as inconsistent (retryable)', (_label, log, message) => {
    const run = () => toTransferRows({ ...input, logs: [log] });
    expect(run).toThrow(RangeInconsistentError);
    expect(run).toThrow(message);
  });

  it('rejects a non-Transfer log as invalid (not retryable)', () => {
    const erc721 = rpcLog(15n, {
      topics: [TRANSFER_TOPIC, pad(FROM, { size: 32 }), pad(TO, { size: 32 }), hash(1)],
      data: '0x',
    });
    expect(() => toTransferRows({ ...input, logs: [erc721] })).toThrow(InvalidTransferLogError);
  });
});

describe('toBlockHeader', () => {
  const block = {
    number: '0xf',
    hash: hash(15),
    timestamp: '0x6955b900',
  } as unknown as RpcBlock;

  it('reads the number, the lowercase hash and the timestamp', () => {
    const upperHash = { ...block, hash: upper(hash(15)) } as RpcBlock;
    expect(toBlockHeader(upperHash, 15n)).toEqual({
      number: 15n,
      hash: hash(15),
      timestamp: 0x6955b900n,
    });
  });

  it('rejects a null block: the node is behind', () => {
    expect(() => toBlockHeader(null, 15n)).toThrow(RangeInconsistentError);
  });

  it('rejects a block with another number', () => {
    expect(() => toBlockHeader(block, 16n)).toThrow(/asked for block 16, got block 15/);
  });

  it('rejects a pending block with no hash', () => {
    expect(() => toBlockHeader({ ...block, hash: null } as RpcBlock, 15n)).toThrow(
      RangeInconsistentError,
    );
  });
});
