import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load-config.js';
import { loggingConfigSchema, migrateConfigSchema } from './schemas.js';

describe('loggingConfigSchema', () => {
  it('defaults to info and dev when unset', () => {
    expect(loadConfig(loggingConfigSchema, {})).toEqual({ LOG_LEVEL: 'info', APP_VERSION: 'dev' });
  });

  it('accepts a pino level and a version', () => {
    expect(loadConfig(loggingConfigSchema, { LOG_LEVEL: 'debug', APP_VERSION: 'abc1234' })).toEqual(
      { LOG_LEVEL: 'debug', APP_VERSION: 'abc1234' },
    );
  });

  it('rejects an unknown level', () => {
    expect(() => loadConfig(loggingConfigSchema, { LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });
});

describe('migrateConfigSchema', () => {
  it('needs DATABASE_URL and fills the logging defaults', () => {
    const url = 'postgres://gapless:gapless@localhost:15432/gapless';
    expect(loadConfig(migrateConfigSchema, { DATABASE_URL: url })).toEqual({
      DATABASE_URL: url,
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
    });
  });
});
