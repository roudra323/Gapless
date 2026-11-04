import 'reflect-metadata';

import type { ApiConfig } from '@gapless/config';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';

import { API_CONFIG } from '../config.provider.js';
import { DB_HANDLE } from '../database/database.tokens.js';
import { HealthService } from './health.service.js';

/** A database handle whose `select 1` result the test controls. */
function fakeDb() {
  const state = { up: true };
  const handle = {
    pool: {
      query: () => (state.up ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('down'))),
    },
  };
  return { state, handle };
}

let app: INestApplicationContext | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(handle: unknown): Promise<{ base: string; service: HealthService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
    providers: [
      HealthService,
      { provide: API_CONFIG, useValue: { METRICS_PORT: 0 } as ApiConfig },
      { provide: DB_HANDLE, useValue: handle },
    ],
  }).compile();
  app = await moduleRef.init();
  const service = app.get(HealthService);
  return { base: `http://127.0.0.1:${service.port()}`, service };
}

describe('HealthService', () => {
  it('is live and ready while the database answers', async () => {
    const { base } = await boot(fakeDb().handle);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('stays live but is not ready while the database is down', async () => {
    const db = fakeDb();
    const { base } = await boot(db.handle);
    db.state.up = false;

    // Live: a DB outage must not make Kubernetes restart every API pod.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);

    db.state.up = true;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('is not ready once shutdown starts, before the servers close', async () => {
    const { base, service } = await boot(fakeDb().handle);

    service.beforeApplicationShutdown();

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it('closes the health server with the app', async () => {
    const { base } = await boot(fakeDb().handle);
    await app?.close();
    app = undefined;

    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});
