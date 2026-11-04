import { type Database, type NewTransferRow, transfers } from '@gapless/db';

export const CHAIN_ID = 31337;
export const TOKEN = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
export const OTHER_TOKEN = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';

/** A lowercase address made from a small number, for readable tests. */
export function address(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function hash(n: bigint | number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

export type SeedTransfer = {
  readonly block: bigint;
  readonly log: number;
  readonly from: string;
  readonly to: string;
  readonly value?: bigint;
  readonly token?: string;
  readonly chainId?: number;
};

let txCounter = 0;

/** Inserts transfers. Each gets a unique tx hash; the block hash is derived from the block. */
export async function insertTransfers(db: Database, rows: readonly SeedTransfer[]): Promise<void> {
  if (rows.length === 0) return;
  const values: NewTransferRow[] = rows.map((row) => ({
    chainId: row.chainId ?? CHAIN_ID,
    blockNumber: row.block,
    blockHash: hash(row.block),
    blockTimestamp: new Date(Date.UTC(2026, 0, 1) + Number(row.block % 1_000_000n) * 1000),
    txHash: hash(++txCounter + 1_000_000),
    logIndex: row.log,
    tokenAddress: row.token ?? TOKEN,
    fromAddress: row.from,
    toAddress: row.to,
    value: row.value ?? 1n,
  }));
  await db.insert(transfers).values(values);
}
