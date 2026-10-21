import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No test files exist until Phase 2; keep `pnpm test` green on the skeleton.
    passWithNoTests: true,
  },
});
