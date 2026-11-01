import { Module } from '@nestjs/common';

import { IngestionService } from './ingestion.service.js';

/**
 * The ingestion feature: the service that runs the loop under leadership. The config, the RPC
 * client and the database come from the global `SharedModule`.
 */
@Module({ providers: [IngestionService], exports: [IngestionService] })
export class IngestionModule {}
