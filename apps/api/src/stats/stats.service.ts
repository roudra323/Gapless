import type { ApiConfig } from '@gapless/config';
import { Inject, Injectable } from '@nestjs/common';

import { API_CONFIG } from '../config.provider.js';
import { StatsRepository } from './stats.repository.js';

/** The indexer's progress as the API reports it (docs/02 "/v1/stats"). */
export type Stats = {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly totalTransfers: bigint;
  /** The block fields are `null` until the indexer has started for this chain and token. */
  readonly lastIndexedBlock: bigint | null;
  readonly headBlock: bigint | null;
  readonly lagBlocks: bigint | null;
  readonly updatedAt: Date | null;
};

@Injectable()
export class StatsService {
  // Value import of StatsRepository: Nest resolves it from the constructor type (docs/05).
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: StatsRepository,
  ) {}

  async get(): Promise<Stats> {
    const { totalTransfers, checkpoint } = await this.repository.read(
      this.config.CHAIN_ID,
      this.config.TOKEN_ADDRESS,
    );
    return {
      chainId: this.config.CHAIN_ID,
      tokenAddress: this.config.TOKEN_ADDRESS,
      totalTransfers,
      lastIndexedBlock: checkpoint?.lastBlock ?? null,
      headBlock: checkpoint?.headBlock ?? null,
      lagBlocks: checkpoint ? lag(checkpoint.headBlock, checkpoint.lastBlock) : null,
      updatedAt: checkpoint?.updatedAt ?? null,
    };
  }
}

/**
 * How far the indexer is behind the head it saw. Never negative: the head is written in the same
 * commit as the checkpoint, but a seed or a rewind can leave it below `last_block` for a moment.
 */
function lag(head: bigint, last: bigint): bigint {
  return head > last ? head - last : 0n;
}
