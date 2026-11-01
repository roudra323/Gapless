import { defineConfig } from 'vitest/config';

import { SOURCE_CONDITIONS } from './vitest.config.js';

// Chaos tests for the indexer (docs/06). Run them with `pnpm test:chaos`: it builds the indexer
// first, because some tests start `dist/main.js` as a child process to send it real signals.
export default defineConfig({
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    include: ['apps/indexer/test/chaos/**/*.chaos.spec.ts'],
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Each file starts its own Postgres and anvil containers.
    maxWorkers: 4,
  },
});
