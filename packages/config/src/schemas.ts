import { z } from 'zod';

/** A `postgres://` or `postgresql://` connection URL. */
const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: (issue) => (issue.input === undefined ? 'is required' : 'must be a postgres:// URL'),
});

/** Env needed to connect to Postgres. Used by the migrate entrypoint (Phase 2); apps extend it later. */
export const dbConfigSchema = z.object({
  DATABASE_URL: postgresUrl,
});

export type DbConfig = z.infer<typeof dbConfigSchema>;
