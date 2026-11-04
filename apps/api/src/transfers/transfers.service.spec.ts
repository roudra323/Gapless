import type { ApiConfig } from '@gapless/config';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { DomainError } from '../common/domain-error.js';
import type { Direction, Transfer } from './transfer.js';
import type { PageRequest, TransfersRepository } from './transfers.repository.js';
import { TransfersService } from './transfers.service.js';

const CONFIG = { CHAIN_ID: 31337, TOKEN_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3' };

function transfer(block: bigint, log: number): Transfer {
  return {
    txHash: `0x${'ab'.repeat(32)}`,
    logIndex: log,
    blockNumber: block,
    blockTimestamp: new Date(0),
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000002',
    value: 1n,
  };
}

/** A repository that returns the first `limit` of a fixed list and records each request. */
function fakeRepository(rows: Transfer[]) {
  const requests: { request: PageRequest; address?: string; direction?: Direction }[] = [];
  const repository = {
    listRecent: (request: PageRequest) => {
      requests.push({ request });
      return Promise.resolve(rows.slice(0, request.limit));
    },
    listForAddress: (request: PageRequest, address: string, direction: Direction) => {
      requests.push({ request, address, direction });
      return Promise.resolve(rows.slice(0, request.limit));
    },
  };
  // Only the two methods the service calls; the cast keeps the fake small.
  return { repository: repository as unknown as TransfersRepository, requests };
}

function service(rows: Transfer[]) {
  const fake = fakeRepository(rows);
  return { ...fake, service: new TransfersService(CONFIG as ApiConfig, fake.repository) };
}

describe('TransfersService', () => {
  it('asks for limit + 1 rows of the configured chain and token', async () => {
    const { service: svc, requests } = service([]);
    await svc.listRecent({ limit: 25 });

    expect(requests[0]?.request).toEqual({
      chainId: 31337,
      tokenAddress: CONFIG.TOKEN_ADDRESS,
      limit: 26,
      after: undefined,
    });
  });

  it('returns limit rows and a cursor at the last one when more rows exist', async () => {
    const rows = [transfer(5n, 0), transfer(4n, 2), transfer(4n, 1)];
    const { service: svc } = service(rows);

    const page = await svc.listRecent({ limit: 2 });

    expect(page.transfers).toEqual(rows.slice(0, 2));
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ blockNumber: 4n, logIndex: 2 });
  });

  it('returns no cursor on the last page', async () => {
    const { service: svc } = service([transfer(5n, 0), transfer(4n, 2)]);

    expect((await svc.listRecent({ limit: 2 })).nextCursor).toBeNull();
    expect((await svc.listRecent({ limit: 3 })).nextCursor).toBeNull();
  });

  it('returns an empty page with no cursor for an empty table', async () => {
    expect(await service([]).service.listRecent({ limit: 25 })).toEqual({
      transfers: [],
      nextCursor: null,
    });
  });

  it('decodes the cursor into the request', async () => {
    const { service: svc, requests } = service([]);
    await svc.listRecent({ limit: 10, cursor: encodeCursor({ blockNumber: 9n, logIndex: 3 }) });

    expect(requests[0]?.request.after).toEqual({ blockNumber: 9n, logIndex: 3 });
  });

  it('rejects a bad cursor before it reads the database', async () => {
    const { service: svc, requests } = service([]);

    await expect(svc.listRecent({ limit: 10, cursor: 'nope' })).rejects.toBeInstanceOf(DomainError);
    await expect(svc.listRecent({ limit: 10, cursor: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    expect(requests).toHaveLength(0);
  });

  it('passes the address and the direction to the repository', async () => {
    const { service: svc, requests } = service([]);
    await svc.listForAddress('0xabc', 'in', { limit: 5 });

    expect(requests[0]).toMatchObject({ address: '0xabc', direction: 'in' });
    expect(requests[0]?.request.limit).toBe(6);
  });
});
