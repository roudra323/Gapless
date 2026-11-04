import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load-config.js';
import { type ApiConfig, apiConfigSchema } from './schemas.js';

const CHECKSUMMED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const VALID_ENV = {
  DATABASE_URL: 'postgres://gapless:gapless@localhost:15432/gapless',
  CHAIN_ID: '31337',
  TOKEN_ADDRESS: CHECKSUMMED,
};

function issuesFor(env: Record<string, string | undefined>) {
  try {
    loadConfig(apiConfigSchema, env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('apiConfigSchema', () => {
  it('parses the required keys and fills the defaults from docs/02', () => {
    expect(loadConfig(apiConfigSchema, VALID_ENV)).toEqual({
      DATABASE_URL: VALID_ENV.DATABASE_URL,
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      CHAIN_ID: 31337,
      TOKEN_ADDRESS: CHECKSUMMED.toLowerCase(),
      SHUTDOWN_TIMEOUT_MS: 20_000,
      METRICS_PORT: 9464,
      PORT: 3000,
    });
  });

  it('reports every missing required key at once', () => {
    expect(issuesFor({})).toEqual([
      { key: 'DATABASE_URL', message: 'is required' },
      { key: 'CHAIN_ID', message: 'is required' },
      { key: 'TOKEN_ADDRESS', message: 'is required' },
    ]);
  });

  it('does not need the indexer keys', () => {
    // The API reads Postgres only. It must boot without an RPC URL or a start block.
    expect(() => loadConfig(apiConfigSchema, VALID_ENV)).not.toThrow();
  });

  it('drops keys it does not use, so the RPC secret never reaches the API config', () => {
    // One shared .env holds every key locally; a Zod object strips unknown keys by default.
    const config = loadConfig(apiConfigSchema, {
      ...VALID_ENV,
      RPC_HTTP_URL: 'https://rpc.example/v2/key-hunter2',
    });
    expect(JSON.stringify(config)).not.toContain('hunter2');
  });

  // A typed tuple: `key` must be a real config key, so `config[key]` type-checks.
  it.each<[keyof ApiConfig, string, number]>([
    ['PORT', '0', 0],
    ['PORT', '8080', 8080],
    ['METRICS_PORT', '0', 0],
  ])('accepts %s=%s', (key, value, expected) => {
    expect(loadConfig(apiConfigSchema, { ...VALID_ENV, [key]: value })[key]).toBe(expected);
  });

  it.each([
    ['PORT', '65536', 'must be a port number (0-65535)'],
    ['PORT', '', 'must be a whole number'],
    ['PORT', 'abc', 'must be a whole number'],
    ['SHUTDOWN_TIMEOUT_MS', '50', 'must be a whole number of at least 100'],
  ])('rejects %s=%s', (key, value, message) => {
    expect(issuesFor({ ...VALID_ENV, [key]: value })).toEqual([{ key, message }]);
  });
});
