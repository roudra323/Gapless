import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests need Docker; they run with `pnpm test:integration` (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, '**/*.int.spec.ts'],
  },
});
