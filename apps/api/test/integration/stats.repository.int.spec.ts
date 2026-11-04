import { indexerCheckpoints } from '@gapless/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { StatsRepository } from '../../src/stats/stats.repository.js';
import { startPostgres, type TestPostgres } from './harness/postgres.js';
import { address, CHAIN_ID, insertTransfers, OTHER_TOKEN, TOKEN } from './harness/seed.js';

let pg: TestPostgres;
let repo: StatsRepository;

beforeAll(async () => {
  pg = await startPostgres();
  repo = new StatsRepository(pg.handle);
});

afterAll(async () => {
  await pg?.stop();
});

describe('StatsRepository', () => {
  beforeEach(async () => {
    await pg.handle.db.execute(sql`truncate transfers, indexer_checkpoints`);
  });

  it('has no checkpoint and a zero count before the indexer starts', async () => {
    expect(await repo.read(CHAIN_ID, TOKEN)).toEqual({ totalTransfers: 0n, checkpoint: undefined });
  });

  it('counts only the chain and token, and reads the checkpoint', async () => {
    const A = address(1);
    const B = address(2);
    await insertTransfers(pg.handle.db, [
      { block: 1n, log: 0, from: A, to: B },
      { block: 2n, log: 0, from: A, to: B },
      { block: 2n, log: 1, from: A, to: B, token: OTHER_TOKEN },
      { block: 3n, log: 0, from: A, to: B, chainId: 1 },
    ]);
    const updatedAt = new Date('2026-11-05T10:00:00Z');
    await pg.handle.db.insert(indexerCheckpoints).values({
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      lastBlock: 2n,
      lastBlockHash: `0x${'0'.repeat(63)}2`,
      headBlock: 7n,
      updatedAt,
    });

    expect(await repo.read(CHAIN_ID, TOKEN)).toEqual({
      totalTransfers: 2n,
      checkpoint: { lastBlock: 2n, headBlock: 7n, updatedAt },
    });
  });

  it('counts with an index-only scan, not a table scan', async () => {
    await pg.handle.db.execute(sql`
      insert into transfers (chain_id, block_number, block_hash, block_timestamp, tx_hash,
        log_index, token_address, from_address, to_address, value)
      select ${CHAIN_ID}, g / 10, '0x' || lpad(to_hex(g / 10), 64, '0'), now(),
        '0x' || lpad(to_hex(g), 64, '0'), g % 10, ${TOKEN}, ${address(1)}, ${address(2)}, 1
      from generate_series(1, 50000) as g`);
    // VACUUM sets the visibility map, so the scan does not need the table at all.
    await pg.handle.pool.query('vacuum analyze transfers');

    const plan = await pg.handle.pool.query<{ 'QUERY PLAN': string }>(
      `explain select count(*) from transfers where chain_id = $1 and token_address = $2`,
      [CHAIN_ID, TOKEN],
    );
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(text).toContain('Index Only Scan using transfers_token_idx');
    expect(text).not.toContain('Seq Scan');
  });
});
