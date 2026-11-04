import 'reflect-metadata';

import { loggerOptions } from '@gapless/observability';
import {
  BadRequestException,
  Controller,
  Get,
  type INestApplication,
  PayloadTooLargeException,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainError, ERROR_CODE } from './domain-error.js';
import {
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsFilter,
  STATUS_BY_CODE,
  toProblem,
} from './problem-details.filter.js';

const SECRET = 'postgres://user:hunter2@db:5432/gapless';

describe('toProblem', () => {
  it('maps a DomainError to its status, with its own message', () => {
    expect(toProblem(new DomainError(ERROR_CODE.INVALID_CURSOR, 'cursor is not valid'))).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'cursor is not valid',
      errorCode: 'INVALID_CURSOR',
    });
  });

  it('maps every error code to a status', () => {
    for (const code of Object.values(ERROR_CODE)) {
      expect(toProblem(new DomainError(code, 'x')).status).toBe(STATUS_BY_CODE[code]);
    }
  });

  it('maps a Nest 4xx to INVALID_REQUEST with a fixed detail, not the input', () => {
    const body = toProblem(new BadRequestException(`limit: ${SECRET}`));
    expect(body).toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('keeps the status and title of other Nest 4xx errors', () => {
    expect(toProblem(new PayloadTooLargeException())).toMatchObject({
      status: 413,
      title: 'Payload Too Large',
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('maps anything else to a generic 500', () => {
    for (const thrown of [new Error(SECRET), SECRET, undefined, { status: 400 }]) {
      const body = toProblem(thrown);
      expect(body).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred.',
        errorCode: 'INTERNAL_ERROR',
      });
    }
  });
});

@Controller()
class ThrowingController {
  @Get('domain')
  domain(): never {
    throw new DomainError(ERROR_CODE.INVALID_CURSOR, 'cursor is not valid');
  }

  @Get('unavailable')
  unavailable(): never {
    throw new DomainError(
      ERROR_CODE.SERVICE_UNAVAILABLE,
      'database unreachable',
      new Error(`connect ECONNREFUSED ${SECRET}`),
    );
  }

  @Get('bug')
  bug(): never {
    throw new Error(`relation "transfers" does not exist: ${SECRET}`);
  }
}

type LogLine = Record<string, unknown>;

// nestjs-pino keeps one root logger per module graph, so this file boots one app for all tests.
describe('ProblemDetailsFilter', () => {
  const lines: LogLine[] = [];
  let app: INestApplication;

  beforeAll(async () => {
    const stream = { write: (line: string) => lines.push(JSON.parse(line) as LogLine) };
    const options = {
      ...loggerOptions({ service: 'api', version: 'test', level: 'info' }),
      wrapSerializers: false,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [options, stream] })],
      controllers: [ThrowingController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers a DomainError as problem+json, and does not log a 4xx as an error', async () => {
    lines.length = 0;
    const res = await request(app.getHttpServer()).get('/domain');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'cursor is not valid',
      errorCode: 'INVALID_CURSOR',
    });
    expect(lines.find((line) => line.msg === 'request failed')).toBeUndefined();
  });

  it('answers an unknown route with 404 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer()).get('/v1/nope');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.body).toMatchObject({ errorCode: 'NOT_FOUND', title: 'Not Found' });
  });

  it('answers a bug with a generic 500, and logs the real error server-side', async () => {
    const res = await request(app.getHttpServer()).get('/bug');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    // Nothing from the real error reaches the client: no message, no SQL, no stack.
    expect(res.text).not.toMatch(/hunter2|relation|stack|at /);

    const logged = lines.find((line) => line.msg === 'request failed');
    expect(logged).toMatchObject({ level: 'error', errorCode: 'INTERNAL_ERROR' });
    expect(JSON.stringify(logged)).toContain('relation \\"transfers\\" does not exist');
  });

  it('answers SERVICE_UNAVAILABLE with 503 and logs the cause', async () => {
    lines.length = 0;
    const res = await request(app.getHttpServer()).get('/unavailable');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      errorCode: 'SERVICE_UNAVAILABLE',
      detail: 'database unreachable',
    });
    expect(res.text).not.toContain('ECONNREFUSED');

    const logged = lines.find((line) => line.msg === 'request failed');
    expect(JSON.stringify(logged)).toContain('ECONNREFUSED');
  });
});
