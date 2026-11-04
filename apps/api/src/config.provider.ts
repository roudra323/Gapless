import type { ApiConfig } from '@gapless/config';
import type { ValueProvider } from '@nestjs/common';

/**
 * DI token for the validated `ApiConfig`. `main.ts` parses the env once, and classes receive the
 * typed object with `@Inject(API_CONFIG)` (docs/05 "Configuration").
 */
export const API_CONFIG = Symbol('API_CONFIG');

/** Provides an already-validated config. Never parses `process.env` itself. */
export function apiConfigProvider(config: ApiConfig): ValueProvider<ApiConfig> {
  return { provide: API_CONFIG, useValue: config };
}
