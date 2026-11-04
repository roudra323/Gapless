import { indexerCheckpoints } from '@gapless/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgres, type TestPostgres } from '../integration/harness/postgres.js';
import { address, CHAIN_ID, insertTransfers, TOKEN } from '../integration/harness/seed.js';
import { startApi, type TestApi } from './harness/api.js';

let pg: TestPostgres;
let api: TestApi;

beforeAll(async () => {
  pg = await startPostgres();
  api = await startApi(pg.url);
});

afterAll(async () => {
  await api?.close();
  await pg?.stop();
});

describe('GET /v1/stats', () => {
  it('reports nulls and a zero count before the indexer starts', async () => {
    const res = await request(api.server).get('/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chainId: CHAIN_ID,
      tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      totalTransfers: '0',
      lastIndexedBlock: null,
      headBlock: null,
      lagBlocks: null,
      updatedAt: null,
    });
  });

  it('reports the checkpoint, the lag and the count as strings', async () => {
    await insertTransfers(pg.handle.db, [
      { block: 10n, log: 0, from: address(1), to: address(2) },
      { block: 11n, log: 0, from: address(2), to: address(1) },
      { block: 11n, log: 1, from: address(1), to: address(3) },
    ]);
    await pg.handle.db.insert(indexerCheckpoints).values({
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      lastBlock: 11n,
      lastBlockHash: `0x${'ab'.repeat(32)}`,
      headBlock: 23n,
      updatedAt: new Date('2026-11-05T10:00:00Z'),
    });

    const res = await request(api.server).get('/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chainId: CHAIN_ID,
      tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      totalTransfers: '3',
      lastIndexedBlock: '11',
      headBlock: '23',
      lagBlocks: '12',
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
  });
});
