import { z } from 'zod';

/** One invalid env key. Holds the key and the reason only, never the value (it may be a secret). */
export type ConfigIssue = {
  readonly key: string;
  readonly message: string;
};

/** Thrown by {@link loadConfig} when the environment does not match the schema. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.key} (${issue.message})`).join(', ')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables against a Zod schema and returns the typed result.
 * This is the only function in the repo that reads `process.env` (see docs/05 "Configuration").
 *
 * @throws {ConfigError} when a key is missing or invalid. The error never contains env values.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        // Zod's default messages describe the rule, not the input, so they are safe to show.
        message: issue.message,
      })),
    );
  }
  return result.data;
}
