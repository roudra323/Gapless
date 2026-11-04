import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import type { ApiConfig } from '@gapless/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { HealthService } from './health/health.service.js';
import { LifecycleService } from './lifecycle.service.js';

// Port 1 refuses connections at once: every query fails like a database that is down.
const TEST_CONFIG: ApiConfig = {
  DATABASE_URL: 'postgres://gapless:db-hunter2@127.0.0.1:1/gapless',
  LOG_LEVEL: 'info',
  APP_VERSION: 'test-sha',
  CHAIN_ID: 31337,
  TOKEN_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  SHUTDOWN_TIMEOUT_MS: 20_000,
  METRICS_PORT: 0,
  PORT: 0,
};

type LogLine = Record<string, unknown>;

describe('AppModule', () => {
  // nestjs-pino keeps one root logger per module graph (its first destination wins), so this file
  // boots one application, in one test (the same as the indexer's app.module.spec.ts).
  it('boots the whole API, logs JSON with reqId, answers 503 problem+json when the DB is down, and shuts down', async () => {
    const lines: LogLine[] = [];
    const stream = { write: (line: string) => lines.push(JSON.parse(line) as LogLine) };
    const find = (msg: string) => lines.find((line) => line.msg === msg);

    // The same options as main.ts.
    const app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(TEST_CONFIG, stream),
      { bufferLogs: true, abortOnError: false },
    );
    app.useLogger(app.get(Logger));
    app.disable('x-powered-by');
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    app.get(LifecycleService).started(port);

    expect(find('api started')).toMatchObject({
      level: 'info',
      service: 'api',
      version: 'test-sha',
      context: 'LifecycleService',
      port,
      chainId: 31337,
    });

    // A request: the DB is down, so 503 problem+json, and the reqId is echoed.
    const res = await request(app.getHttpServer())
      .get('/v1/transfers')
      .set('x-request-id', 'test-req-1');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe('test-req-1');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.body).toMatchObject({ errorCode: 'SERVICE_UNAVAILABLE', status: 503 });
    expect(res.text).not.toMatch(/ECONNREFUSED|hunter2|select/);

    // The filter's error line and the request line both carry the reqId.
    const failed = find('request failed');
    expect(failed).toMatchObject({
      level: 'error',
      reqId: 'test-req-1',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
    expect(JSON.stringify(failed)).toContain('ECONNREFUSED');
    const completed = lines.find((line) => line.reqId === 'test-req-1' && line.res !== undefined);
    expect(completed).toMatchObject({
      req: { method: 'GET', url: '/v1/transfers' },
      res: { statusCode: 503 },
    });
    expect(completed).toHaveProperty('responseTime');
    // The short serializers: no headers in the log.
    expect(JSON.stringify(completed)).not.toContain('x-request-id');

    // Without an incoming header, the API makes one.
    const generated = await request(app.getHttpServer()).get('/v1/stats');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    // A validation error is a 400 and never reaches the DB.
    const bad = await request(app.getHttpServer()).get('/v1/transfers?limit=0');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errorCode: 'INVALID_REQUEST' });

    // The health server: live, but not ready (the DB is down).
    const healthPort = app.get(HealthService).port();
    expect((await fetch(`http://127.0.0.1:${healthPort}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${healthPort}/readyz`)).status).toBe(503);
    // The health endpoints are not on the public port.
    expect((await request(app.getHttpServer()).get('/healthz')).status).toBe(404);

    await app.close();
    expect(find('api stopped')).toMatchObject({ context: 'LifecycleService' });
    await expect(fetch(`http://127.0.0.1:${healthPort}/healthz`)).rejects.toThrow();
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });
});
