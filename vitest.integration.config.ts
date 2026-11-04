import { defineConfig } from 'vitest/config';

import { SOURCE_CONDITIONS } from './vitest.config.js';

export default defineConfig({
  // Test the workspace packages' `src/`, not their last build (see vitest.config.ts).
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    include: [
      '{apps,packages}/*/test/integration/**/*.int.spec.ts',
      // The API e2e tests boot the whole Nest app against a Postgres container.
      'apps/api/test/e2e/**/*.e2e.spec.ts',
    ],
    // The first run pulls the image, and every suite starts its own container.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
