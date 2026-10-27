import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/test/integration/**/*.int.spec.ts'],
    // The first run pulls the image, and every suite starts its own container.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
