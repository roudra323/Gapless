import type { ApiConfig } from '@gapless/config';
import { Inject, Injectable } from '@nestjs/common';

import { type Cursor, decodeCursor, encodeCursor } from '../common/cursor.js';
import { API_CONFIG } from '../config.provider.js';
import type { Direction, Transfer } from './transfer.js';
import { type PageRequest, TransfersRepository } from './transfers.repository.js';

/** One page of transfers, and the cursor of the next page (`null` on the last page). */
export type TransferPage = {
  readonly transfers: readonly Transfer[];
  readonly nextCursor: string | null;
};

/** What a client asks for: a page size and, after the first page, the cursor it was given. */
export type PageInput = {
  readonly limit: number;
  readonly cursor?: string | undefined;
};

/**
 * Keyset pagination over the configured chain and token (docs/02 "Pagination"). It knows nothing
 * about HTTP: a bad cursor is a `DomainError` (docs/05 "NestJS structure").
 */
@Injectable()
export class TransfersService {
  // Value import of TransfersRepository: Nest resolves it from the constructor type (docs/05).
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: TransfersRepository,
  ) {}

  listRecent(input: PageInput): Promise<TransferPage> {
    return this.page(input, (request) => this.repository.listRecent(request));
  }

  /** `address` is lowercase (the param schema normalizes it). */
  listForAddress(address: string, direction: Direction, input: PageInput): Promise<TransferPage> {
    return this.page(input, (request) =>
      this.repository.listForAddress(request, address, direction),
    );
  }

  /**
   * Reads `limit + 1` rows: if the extra row exists, there is a next page, and its cursor is the
   * last row the client gets. No `COUNT(*)` and no second query.
   */
  private async page(
    input: PageInput,
    read: (request: PageRequest) => Promise<Transfer[]>,
  ): Promise<TransferPage> {
    const after: Cursor | undefined =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await read({
      chainId: this.config.CHAIN_ID,
      tokenAddress: this.config.TOKEN_ADDRESS,
      limit: input.limit + 1,
      after,
    });

    const transfers = rows.slice(0, input.limit);
    const last = transfers.at(-1);
    const nextCursor =
      rows.length > input.limit && last
        ? encodeCursor({ blockNumber: last.blockNumber, logIndex: last.logIndex })
        : null;
    return { transfers, nextCursor };
  }
}
