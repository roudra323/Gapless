import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load-config.js';
import { dbConfigSchema } from './schemas.js';

const VALID_URL = 'postgres://gapless:s3cret@localhost:15432/gapless';

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(dbConfigSchema, env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig with dbConfigSchema', () => {
  it('returns the typed config for a valid postgres:// URL', () => {
    expect(loadConfig(dbConfigSchema, { DATABASE_URL: VALID_URL })).toEqual({
      DATABASE_URL: VALID_URL,
    });
  });

  it('accepts the postgresql:// scheme', () => {
    const url = 'postgresql://gapless:gapless@db:5432/gapless';
    expect(loadConfig(dbConfigSchema, { DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('drops keys that are not in the schema', () => {
    const config = loadConfig(dbConfigSchema, { DATABASE_URL: VALID_URL, OTHER: 'x' });
    expect(config).not.toHaveProperty('OTHER');
  });

  it('reports a missing key', () => {
    const error = captureConfigError({});
    expect(error.issues).toEqual([{ key: 'DATABASE_URL', message: 'is required' }]);
  });

  it.each([
    ['not a URL', 'not-a-url'],
    ['wrong scheme', 'mysql://gapless:gapless@localhost:3306/gapless'],
    ['empty string', ''],
  ])('reports a malformed value (%s)', (_label, value) => {
    const error = captureConfigError({ DATABASE_URL: value });
    expect(error.issues).toEqual([{ key: 'DATABASE_URL', message: 'must be a postgres:// URL' }]);
  });

  it('never puts the value in the error', () => {
    const secretButInvalid = 'mysql://admin:hunter2@db.internal/prod';
    const error = captureConfigError({ DATABASE_URL: secretButInvalid });
    expect(error.message).not.toContain('hunter2');
    expect(JSON.stringify(error.issues)).not.toContain('hunter2');
  });
});
