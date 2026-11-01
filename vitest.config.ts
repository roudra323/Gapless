import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Resolve workspace packages to their `src/` through the `@gapless/source` export condition (the
 * same condition as `customConditions` in tsconfig.base.json). Without it, Vitest loads `dist/`,
 * and a test runs against the last build instead of the code under test. The rest is Vite's
 * default server list (`defaultServerConditions`).
 */
export const SOURCE_CONDITIONS = ['@gapless/source', 'module', 'node', 'development|production'];

export default defineConfig({
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    // Integration and chaos tests need Docker; they run with `pnpm test:integration` and
    // `pnpm test:chaos` (vitest.integration.config.ts, vitest.chaos.config.ts).
    exclude: [...configDefaults.exclude, '**/*.int.spec.ts', '**/*.chaos.spec.ts'],
  },
});
