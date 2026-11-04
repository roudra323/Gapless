import { Controller, Get } from '@nestjs/common';

import { toStatsResponse, type StatsResponse } from './stats.response.js';
import { StatsService } from './stats.service.js';

/** `GET /v1/stats` (docs/02 "API contract"). */
@Controller('v1')
export class StatsController {
  // Value import: Nest resolves StatsService from the constructor type (docs/05).
  constructor(private readonly stats: StatsService) {}

  @Get('stats')
  async get(): Promise<StatsResponse> {
    return toStatsResponse(await this.stats.get());
  }
}
