import { Module } from '@nestjs/common';

import { HealthService } from './health.service.js';

/** `/healthz`, `/readyz` and `/metrics` on `METRICS_PORT`. Uses the global `SharedModule` providers. */
@Module({ providers: [HealthService], exports: [HealthService] })
export class HealthModule {}
