import { Controller, Get, Param, Query } from '@nestjs/common';

import { ERROR_CODE } from '../common/domain-error.js';
import { validated } from '../common/validation.js';
import { toTransferResponse, type TransferPageResponse } from './transfer.response.js';
import {
  addressParamSchema,
  addressTransfersQuerySchema,
  type AddressTransfersQuery,
  listTransfersQuerySchema,
  type ListTransfersQuery,
} from './transfers.schemas.js';
import { type TransferPage, TransfersService } from './transfers.service.js';

/**
 * `GET /v1/transfers` and `GET /v1/addresses/:address/transfers` (docs/02 "API contract").
 * HTTP only: validate, call the service, map to the response shape (docs/05 "NestJS structure").
 */
@Controller('v1')
export class TransfersController {
  // Value import: Nest resolves TransfersService from the constructor type (docs/05).
  constructor(private readonly transfers: TransfersService) {}

  @Get('transfers')
  async list(
    @Query(validated(listTransfersQuerySchema, ERROR_CODE.INVALID_REQUEST))
    query: ListTransfersQuery,
  ): Promise<TransferPageResponse> {
    return toPageResponse(await this.transfers.listRecent(query));
  }

  @Get('addresses/:address/transfers')
  async listForAddress(
    @Param('address', validated(addressParamSchema, ERROR_CODE.INVALID_ADDRESS)) address: string,
    @Query(validated(addressTransfersQuerySchema, ERROR_CODE.INVALID_REQUEST))
    query: AddressTransfersQuery,
  ): Promise<TransferPageResponse> {
    return toPageResponse(await this.transfers.listForAddress(address, query.direction, query));
  }
}

function toPageResponse(page: TransferPage): TransferPageResponse {
  return { data: page.transfers.map(toTransferResponse), nextCursor: page.nextCursor };
}
