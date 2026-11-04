import { toChecksum } from '@gapless/chain';

import type { Stats } from './stats.service.js';

/** The `/v1/stats` body (docs/02). On-chain integers and counts are decimal strings. */
export type StatsResponse = {
  readonly chainId: number;
  /** EIP-55 checksummed. */
  readonly tokenAddress: string;
  readonly totalTransfers: string;
  readonly lastIndexedBlock: string | null;
  readonly headBlock: string | null;
  readonly lagBlocks: string | null;
  /** ISO 8601 in UTC: when the indexer last wrote its checkpoint. */
  readonly updatedAt: string | null;
};

export function toStatsResponse(stats: Stats): StatsResponse {
  return {
    chainId: stats.chainId,
    tokenAddress: toChecksum(stats.tokenAddress),
    totalTransfers: stats.totalTransfers.toString(),
    lastIndexedBlock: stats.lastIndexedBlock?.toString() ?? null,
    headBlock: stats.headBlock?.toString() ?? null,
    lagBlocks: stats.lagBlocks?.toString() ?? null,
    updatedAt: stats.updatedAt?.toISOString() ?? null,
  };
}
