import { indexerCheckpoints, type NewTransferRow, transfers } from '@gapless/db';
import { sql } from 'drizzle-orm';
import { type Address, type Hex, numberToHex, pad } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointFenceError } from '../../src/ingestion/ingestion-errors.js';
import { type Checkpoint, IndexerRepository } from '../../src/ingestion/indexer.repository.js';
import { startPostgres, type TestPostgres } from './harness/postgres.js';

const CHAIN_ID = 31337;
const TOKEN: Address = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const OTHER_TOKEN: Address = '0x9999999999999999999999999999999999999999';

function hash(n: number): Hex {
  return pad(numberToHex(n), { size: 32 });
}

function row(block: bigint, logIndex: number, tokenAddress: Address = TOKEN): NewTransferRow {
  return {
    chainId: CHAIN_ID,
    blockNumber: block,
    blockHash: hash(Number(block)),
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    txHash: hash(100_000 + Number(block)),
    logIndex,
    tokenAddress,
    fromAddress: `0x${'1'.repeat(40)}`,
    toAddress: `0x${'2'.repeat(40)}`,
    value: 1n,
  };
}

const SEED: Checkpoint = { lastBlock: 9n, lastBlockHash: hash(9), headBlock: 9n };

let pg: TestPostgres;
let repo: IndexerRepository;

beforeAll(async () => {
  pg = await startPostgres();
  repo = new IndexerRepository(pg.handle.db, CHAIN_ID, TOKEN);
});

afterAll(async () => {
  await pg?.stop();
});

beforeEach(async () => {
  await pg.handle.db.execute(sql`TRUNCATE ${transfers}, ${indexerCheckpoints}`);
});

describe('IndexerRepository', () => {
  it('reads null before the first seed', async () => {
    expect(await repo.readCheckpoint()).toBeNull();
  });

  it('seeds the checkpoint once and never overwrites it', async () => {
    await repo.seedCheckpoint(SEED);
    await repo.seedCheckpoint({ lastBlock: 0n, lastBlockHash: hash(0), headBlock: 0n });

    expect(await repo.readCheckpoint()).toEqual(SEED);
  });

  it('keeps the checkpoints of other tokens apart', async () => {
    await new IndexerRepository(pg.handle.db, CHAIN_ID, OTHER_TOKEN).seedCheckpoint({
      ...SEED,
      lastBlock: 500n,
    });
    expect(await repo.readCheckpoint()).toBeNull();
  });

  it('moves the checkpoint and inserts the rows in one commit', async () => {
    await repo.seedCheckpoint(SEED);

    const result = await repo.commitBatch({
      rows: [row(10n, 0), row(10n, 1), row(12n, 0)],
      from: 10n,
      to: 14n,
      toHash: hash(14),
      headBlock: 20n,
    });

    const expected = { lastBlock: 14n, lastBlockHash: hash(14), headBlock: 20n };
    expect(result).toEqual({ checkpoint: expected, inserted: 3 });
    expect(await repo.readCheckpoint()).toEqual(expected);
    expect(await pg.handle.db.$count(transfers)).toBe(3);
  });

  it('commits a range with no transfers (the checkpoint still moves)', async () => {
    await repo.seedCheckpoint(SEED);

    const result = await repo.commitBatch({
      rows: [],
      from: 10n,
      to: 2009n,
      toHash: hash(2009),
      headBlock: 2100n,
    });
    expect(result.inserted).toBe(0);
    expect(result.checkpoint.lastBlock).toBe(2009n);
  });

  it('counts only new rows when a range is committed again (idempotent writes)', async () => {
    await repo.seedCheckpoint(SEED);
    await repo.commitBatch({
      rows: [row(10n, 0)],
      from: 10n,
      to: 10n,
      toHash: hash(10),
      headBlock: 10n,
    });

    // The same log again in the next range, as after a crash between the RPC answer and a retry.
    const result = await repo.commitBatch({
      rows: [row(10n, 0), row(11n, 0)],
      from: 11n,
      to: 11n,
      toHash: hash(11),
      headBlock: 11n,
    });
    expect(result.inserted).toBe(1);
    expect(await pg.handle.db.$count(transfers)).toBe(2);
  });

  it('rolls back the rows when the fence does not match (atomic progress)', async () => {
    await repo.seedCheckpoint(SEED);

    // Another writer already moved the checkpoint from 9 to 14.
    await repo.commitBatch({ rows: [], from: 10n, to: 14n, toHash: hash(14), headBlock: 14n });

    await expect(
      repo.commitBatch({
        rows: [row(10n, 0), row(11n, 0)],
        from: 10n,
        to: 20n,
        toHash: hash(20),
        headBlock: 20n,
      }),
    ).rejects.toBeInstanceOf(CheckpointFenceError);

    expect(await pg.handle.db.$count(transfers)).toBe(0);
    expect((await repo.readCheckpoint())?.lastBlock).toBe(14n);
  });

  it('fails the fence when there is no checkpoint row', async () => {
    await expect(
      repo.commitBatch({
        rows: [row(10n, 0)],
        from: 10n,
        to: 10n,
        toHash: hash(10),
        headBlock: 10n,
      }),
    ).rejects.toBeInstanceOf(CheckpointFenceError);
    expect(await pg.handle.db.$count(transfers)).toBe(0);
  });

  it('rolls back every chunk when a later chunk fails', async () => {
    await repo.seedCheckpoint(SEED);
    const rows = Array.from({ length: 1500 }, (_, i) => row(10n, i));
    // The second chunk holds an invalid row (uppercase hash), so the DB check constraint fails.
    rows[1200] = { ...row(10n, 1200), blockHash: hash(10).toUpperCase().replace('0X', '0x') };

    await expect(
      repo.commitBatch({ rows, from: 10n, to: 10n, toHash: hash(10), headBlock: 10n }),
    ).rejects.toThrow();
    expect(await pg.handle.db.$count(transfers)).toBe(0);
    expect(await repo.readCheckpoint()).toEqual(SEED);
  });

  it('inserts a range bigger than one INSERT can hold', async () => {
    await repo.seedCheckpoint(SEED);
    // 7000 rows × 10 columns is above the 65 535 bind parameters of one statement.
    const rows = Array.from({ length: 7000 }, (_, i) => row(10n + BigInt(i % 50), i));

    const result = await repo.commitBatch({
      rows,
      from: 10n,
      to: 59n,
      toHash: hash(59),
      headBlock: 60n,
    });
    expect(result.inserted).toBe(7000);
    expect(await pg.handle.db.$count(transfers)).toBe(7000);
  });
});

const other = () => new IndexerRepository(pg.handle.db, CHAIN_ID, OTHER_TOKEN);

async function indexed(blocks: readonly bigint[], to: bigint): Promise<void> {
  await repo.seedCheckpoint(SEED);
  await repo.commitBatch({
    rows: blocks.map((block) => row(block, 0)),
    from: 10n,
    to,
    toHash: hash(Number(to)),
    headBlock: to,
  });
}

describe('IndexerRepository reorg support', () => {
  it('finds the newest stored block at or below a block', async () => {
    await indexed([10n, 12n, 15n], 20n);
    expect(await repo.newestTransferBlockAtOrBelow(14n)).toEqual({
      blockNumber: 12n,
      blockHash: hash(12),
    });
    expect(await repo.newestTransferBlockAtOrBelow(15n)).toEqual({
      blockNumber: 15n,
      blockHash: hash(15),
    });
    expect(await repo.newestTransferBlockAtOrBelow(9n)).toBeNull();
  });

  it('ignores the rows of other tokens when it looks for a stored block', async () => {
    await indexed([10n], 20n);
    await other().seedCheckpoint(SEED);
    await other().commitBatch({
      rows: [row(13n, 0, OTHER_TOKEN)],
      from: 10n,
      to: 13n,
      toHash: hash(13),
      headBlock: 13n,
    });
    expect((await repo.newestTransferBlockAtOrBelow(20n))?.blockNumber).toBe(10n);
  });

  it('deletes the rows above the target and moves the checkpoint back in one commit', async () => {
    await indexed([10n, 12n, 15n, 18n], 20n);

    const result = await repo.rewind({
      rewindTo: 12n,
      rewindHash: hash(12),
      expectedLastBlock: 20n,
    });

    expect(result.deleted).toBe(2);
    expect(result.checkpoint).toMatchObject({ lastBlock: 12n, lastBlockHash: hash(12) });
    expect(await repo.readCheckpoint()).toMatchObject({ lastBlock: 12n, lastBlockHash: hash(12) });
    expect((await repo.transferKeys(0n, 100n)).length).toBe(2);
  });

  it('keeps the rows of other tokens on a rewind', async () => {
    await indexed([15n], 20n);
    await other().seedCheckpoint(SEED);
    await other().commitBatch({
      rows: [row(15n, 1, OTHER_TOKEN)],
      from: 10n,
      to: 20n,
      toHash: hash(20),
      headBlock: 20n,
    });

    await repo.rewind({ rewindTo: 9n, rewindHash: hash(9), expectedLastBlock: 20n });

    expect(await pg.handle.db.$count(transfers)).toBe(1);
    expect((await other().readCheckpoint())?.lastBlock).toBe(20n);
  });

  it('deletes nothing when the fence does not match', async () => {
    await indexed([10n, 15n], 20n);

    await expect(
      repo.rewind({ rewindTo: 9n, rewindHash: hash(9), expectedLastBlock: 19n }),
    ).rejects.toBeInstanceOf(CheckpointFenceError);

    expect(await pg.handle.db.$count(transfers)).toBe(2);
    expect((await repo.readCheckpoint())?.lastBlock).toBe(20n);
  });
});
