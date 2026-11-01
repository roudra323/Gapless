import type { IndexerConfig } from '@gapless/config';
import type { ValueProvider } from '@nestjs/common';

/**
 * DI token for the validated `IndexerConfig`. `main.ts` parses the env once, and classes receive
 * the typed object with `@Inject(INDEXER_CONFIG)` (docs/05 "Configuration").
 */
export const INDEXER_CONFIG = Symbol('INDEXER_CONFIG');

/** Provides an already-validated config. Never parses `process.env` itself. */
export function indexerConfigProvider(config: IndexerConfig): ValueProvider<IndexerConfig> {
  return { provide: INDEXER_CONFIG, useValue: config };
}
