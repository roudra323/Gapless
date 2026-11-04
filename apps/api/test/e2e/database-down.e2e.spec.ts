import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgres, type TestPostgres } from '../integration/harness/postgres.js';
import { startApi, type TestApi, waitFor } from './harness/api.js';

let pg: TestPostgres;
let api: TestApi;

beforeAll(async () => {
  pg = await startPostgres();
  api = await startApi(pg.url);
});

afterAll(async () => {
  await api?.close();
  // The container is already stopped by the test; `pg.stop()` would close the pool twice.
  await pg?.container.stop();
});

describe('the database goes down', () => {
  it('is ready while the database answers', async () => {
    expect((await fetch(`${api.healthUrl}/readyz`)).status).toBe(200);
    expect((await request(api.server).get('/v1/transfers')).status).toBe(200);
  });

  it('turns /readyz to 503, answers 503 problem+json, and stays live', async () => {
    // Close the test's own pool first: its harness turns an idle connection error into a throw.
    await pg.handle.close();
    await pg.container.stop();

    await waitFor(async () => (await fetch(`${api.healthUrl}/readyz`)).status === 503);
    expect((await fetch(`${api.healthUrl}/healthz`)).status).toBe(200);

    for (const path of [
      '/v1/transfers',
      `/v1/addresses/${'0x'.padEnd(42, '1')}/transfers`,
      '/v1/stats',
    ]) {
      const res = await request(api.server).get(path).set('x-request-id', `down-${path.length}`);
      expect(res.status, path).toBe(503);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: expect.any(String) as unknown,
        errorCode: 'SERVICE_UNAVAILABLE',
      });
      expect(res.text).not.toMatch(/ECONNREFUSED|ECONNRESET|terminat|select|at .+:\d+/i);
    }

    // The full error stays in the server log, with the request ID.
    const failed = api.logs.filter((line) => line.msg === 'request failed');
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed[0]).toMatchObject({ level: 'error', errorCode: 'SERVICE_UNAVAILABLE' });
    expect(failed[0]).toHaveProperty('err');
  });
});
