import { Module } from '@nestjs/common';

import { HealthService } from './health.service.js';

/** `/healthz` and `/readyz` on `METRICS_PORT`. Uses the global `SharedModule` providers. */
@Module({ providers: [HealthService], exports: [HealthService] })
export class HealthModule {}
