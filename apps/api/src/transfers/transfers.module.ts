import { Module } from '@nestjs/common';

import { TransfersController } from './transfers.controller.js';
import { TransfersRepository } from './transfers.repository.js';
import { TransfersService } from './transfers.service.js';

/** The transfer feed endpoints. Uses the global `SharedModule` providers (config, database). */
@Module({
  controllers: [TransfersController],
  providers: [TransfersService, TransfersRepository],
})
export class TransfersModule {}
