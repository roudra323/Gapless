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

/** Env every process needs for logging (docs/09 "Logs"). */
export const loggingConfigSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** The deployed Git SHA (set by Helm from the image tag). `dev` when unset, as in local runs. */
  APP_VERSION: z.string().min(1).default('dev'),
});

export type DbConfig = z.infer<typeof dbConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

/** Env for the migrate entrypoint: the database and logging. */
export const migrateConfigSchema = dbConfigSchema.extend(loggingConfigSchema.shape);

export type MigrateConfig = z.infer<typeof migrateConfigSchema>;
