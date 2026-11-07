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

describe('GET /metrics on METRICS_PORT', () => {
  it('counts requests by route template and status class, and times the queries', async () => {
    await request(api.server).get('/v1/stats');
    await request(api.server).get(`/v1/addresses/${address(1)}/transfers`);
    await request(api.server).get('/v1/addresses/not-an-address/transfers');
    await request(api.server).get('/v1/transfers?limit=1');
    await request(api.server).get('/no/such/route/0xabc');

    const res = await fetch(`${api.healthUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const series = (line: string) => expect(text).toMatch(new RegExp(`^${escape(line)} \\d+`, 'm'));

    series('gapless_http_requests_total{method="GET",route="/v1/stats",status_class="2xx"}');
    // The template, never the address in the URL.
    series(
      'gapless_http_requests_total{method="GET",route="/v1/addresses/:address/transfers",status_class="2xx"}',
    );
    series(
      'gapless_http_requests_total{method="GET",route="/v1/addresses/:address/transfers",status_class="4xx"}',
    );
    series('gapless_http_requests_total{method="GET",route="/v1/transfers",status_class="2xx"}');
    series('gapless_http_requests_total{method="GET",route="unmatched",status_class="4xx"}');
    expect(text).not.toContain('not-an-address');
    expect(text).not.toContain('/no/such/route');
    expect(text).not.toContain('/healthz'); // probes are outside Nest

    series('gapless_http_request_duration_seconds_count{method="GET",route="/v1/stats"}');
    series('gapless_db_query_duration_seconds_count{query="stats"}');
    series('gapless_db_query_duration_seconds_count{query="address_transfers"}');
    series('gapless_db_query_duration_seconds_count{query="recent_transfers"}');
  });
});

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
