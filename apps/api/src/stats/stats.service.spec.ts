import type { ApiConfig } from '@gapless/config';
import { describe, expect, it } from 'vitest';

import { toStatsResponse } from './stats.response.js';
import type { StatsRepository, StatsSnapshot } from './stats.repository.js';
import { StatsService } from './stats.service.js';

const CONFIG = { CHAIN_ID: 31337, TOKEN_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3' };

function service(snapshot: StatsSnapshot) {
  const calls: [number, string][] = [];
  const repository = {
    read: (chainId: number, token: string) => {
      calls.push([chainId, token]);
      return Promise.resolve(snapshot);
    },
  } as unknown as StatsRepository;
  return { calls, service: new StatsService(CONFIG as ApiConfig, repository) };
}

const UPDATED_AT = new Date('2026-11-05T10:00:00Z');

describe('StatsService', () => {
  it('reports the checkpoint and the lag for the configured chain and token', async () => {
    const { service: svc, calls } = service({
      totalTransfers: 402n,
      checkpoint: { lastBlock: 404n, headBlock: 406n, updatedAt: UPDATED_AT },
    });

    expect(await svc.get()).toEqual({
      chainId: 31337,
      tokenAddress: CONFIG.TOKEN_ADDRESS,
      totalTransfers: 402n,
      lastIndexedBlock: 404n,
      headBlock: 406n,
      lagBlocks: 2n,
      updatedAt: UPDATED_AT,
    });
    expect(calls).toEqual([[31337, CONFIG.TOKEN_ADDRESS]]);
  });

  it('reports null block fields before the indexer has started', async () => {
    const stats = await service({ totalTransfers: 0n, checkpoint: undefined }).service.get();

    expect(stats).toMatchObject({
      totalTransfers: 0n,
      lastIndexedBlock: null,
      headBlock: null,
      lagBlocks: null,
      updatedAt: null,
    });
  });

  it('never reports a negative lag', async () => {
    const stats = await service({
      totalTransfers: 0n,
      checkpoint: { lastBlock: 10n, headBlock: 8n, updatedAt: UPDATED_AT },
    }).service.get();

    expect(stats.lagBlocks).toBe(0n);
  });
});

describe('toStatsResponse', () => {
  it('returns decimal strings, a checksummed token and ISO time (docs/02)', async () => {
    const stats = await service({
      totalTransfers: 402n,
      checkpoint: {
        lastBlock: 9007199254740993n,
        headBlock: 9007199254740995n,
        updatedAt: UPDATED_AT,
      },
    }).service.get();

    expect(toStatsResponse(stats)).toEqual({
      chainId: 31337,
      tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      totalTransfers: '402',
      lastIndexedBlock: '9007199254740993',
      headBlock: '9007199254740995',
      lagBlocks: '2',
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
  });

  it('keeps the nulls', async () => {
    const stats = await service({ totalTransfers: 0n, checkpoint: undefined }).service.get();

    expect(toStatsResponse(stats)).toMatchObject({
      totalTransfers: '0',
      lastIndexedBlock: null,
      headBlock: null,
      lagBlocks: null,
      updatedAt: null,
    });
  });
});
