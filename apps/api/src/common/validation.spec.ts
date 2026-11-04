import 'reflect-metadata';

import { Controller, Get, type INestApplication, Param, Query } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addressParamSchema,
  addressTransfersQuerySchema,
  type AddressTransfersQuery,
} from '../transfers/transfers.schemas.js';
import { ERROR_CODE } from './domain-error.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { validated } from './validation.js';

@Controller()
class EchoController {
  @Get('addresses/:address')
  echo(
    @Param('address', validated(addressParamSchema, ERROR_CODE.INVALID_ADDRESS)) address: string,
    @Query(validated(addressTransfersQuerySchema, ERROR_CODE.INVALID_REQUEST))
    query: AddressTransfersQuery,
  ): { address: string; query: AddressTransfersQuery } {
    return { address, query };
  }
}

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('validated', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The filter needs a PinoLogger; level silent keeps the test output clean.
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
      controllers: [EchoController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('passes the parsed values (defaults, lowercase address) to the handler', async () => {
    const res = await request(app.getHttpServer()).get(`/addresses/${ADDRESS}?limit=10`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: ADDRESS.toLowerCase(),
      query: { limit: 10, direction: 'all' },
    });
  });

  it('answers a bad address with 400 INVALID_ADDRESS', async () => {
    const res = await request(app.getHttpServer()).get('/addresses/0x1234');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errorCode: 'INVALID_ADDRESS',
      detail: 'The address is not valid.',
    });
  });

  it('answers a bad query with 400 INVALID_REQUEST and says which key is wrong', async () => {
    const res = await request(app.getHttpServer()).get(`/addresses/${ADDRESS}?limit=500`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errorCode: 'INVALID_REQUEST' });
    expect(res.body.detail).toMatch(/^limit: /);
  });

  it('never repeats the input in the detail', async () => {
    const res = await request(app.getHttpServer()).get(
      `/addresses/${ADDRESS}?direction=hunter2&limit=hunter3`,
    );

    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/hunter/);
  });
});
