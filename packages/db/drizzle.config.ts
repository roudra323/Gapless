import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate`, which diffs the schema against the committed
// snapshots in migrations/meta. It never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
