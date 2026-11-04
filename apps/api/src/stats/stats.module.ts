import { Module } from '@nestjs/common';

import { StatsController } from './stats.controller.js';
import { StatsRepository } from './stats.repository.js';
import { StatsService } from './stats.service.js';

/** `GET /v1/stats`. Uses the global `SharedModule` providers (config, database). */
@Module({
  controllers: [StatsController],
  providers: [StatsService, StatsRepository],
})
export class StatsModule {}
