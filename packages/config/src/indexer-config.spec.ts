import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './load-config.js';
import { indexerConfigSchema } from './schemas.js';

const CHECKSUMMED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const VALID_ENV = {
  DATABASE_URL: 'postgres://gapless:gapless@localhost:15432/gapless',
  CHAIN_ID: '31337',
  TOKEN_ADDRESS: CHECKSUMMED,
  RPC_HTTP_URL: 'http://localhost:8545',
  START_BLOCK: '1',
};

function issuesFor(env: Record<string, string | undefined>) {
  try {
    loadConfig(indexerConfigSchema, env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('indexerConfigSchema', () => {
  it('parses the required keys and fills the defaults from docs/02', () => {
    expect(loadConfig(indexerConfigSchema, VALID_ENV)).toEqual({
      DATABASE_URL: VALID_ENV.DATABASE_URL,
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      CHAIN_ID: 31337,
      TOKEN_ADDRESS: CHECKSUMMED.toLowerCase(),
      RPC_HTTP_URL: 'http://localhost:8545',
      START_BLOCK: 1n,
      CONFIRMATIONS: 5n,
      BATCH_SIZE: 2000n,
      POLL_INTERVAL_MS: 4000,
      REORG_REWIND_BLOCKS: 64n,
      SHUTDOWN_TIMEOUT_MS: 20_000,
      METRICS_PORT: 9464,
    });
  });

  it('keeps block numbers above 2^53 exact', () => {
    const config = loadConfig(indexerConfigSchema, {
      ...VALID_ENV,
      START_BLOCK: '9007199254740993',
    });
    expect(config.START_BLOCK).toBe(9007199254740993n);
  });

  it('reports every missing required key at once', () => {
    expect(issuesFor({})).toEqual([
      { key: 'DATABASE_URL', message: 'is required' },
      { key: 'CHAIN_ID', message: 'is required' },
      { key: 'TOKEN_ADDRESS', message: 'is required' },
      { key: 'RPC_HTTP_URL', message: 'is required' },
      { key: 'START_BLOCK', message: 'is required' },
    ]);
  });

  describe('TOKEN_ADDRESS', () => {
    it('rejects the zero address (the .env.example placeholder)', () => {
      expect(
        issuesFor({ ...VALID_ENV, TOKEN_ADDRESS: '0x0000000000000000000000000000000000000000' }),
      ).toEqual([
        {
          key: 'TOKEN_ADDRESS',
          message: 'must not be the zero address (set it after deploying the token)',
        },
      ]);
    });

    it('accepts an all-lowercase address', () => {
      const lower = CHECKSUMMED.toLowerCase();
      expect(
        loadConfig(indexerConfigSchema, { ...VALID_ENV, TOKEN_ADDRESS: lower }).TOKEN_ADDRESS,
      ).toBe(lower);
    });

    it.each([
      ['a wrong checksum (typo)', CHECKSUMMED.replace('F6', 'f6')],
      ['too short', '0x1234'],
      ['no 0x prefix', CHECKSUMMED.slice(2)],
    ])('rejects %s', (_label, value) => {
      expect(issuesFor({ ...VALID_ENV, TOKEN_ADDRESS: value })).toEqual([
        { key: 'TOKEN_ADDRESS', message: 'must be a 0x address (lowercase or EIP-55 checksummed)' },
      ]);
    });
  });

  describe('whole numbers', () => {
    // z.coerce would accept all of these: '' as 0, '1e3' as 1000, ' 5' as 5.
    it.each([
      ['an empty value', ''],
      ['an exponent', '1e3'],
      ['a padded value', ' 5'],
      ['a negative value', '-1'],
      ['a decimal', '2.5'],
    ])('rejects %s instead of coercing it', (_label, value) => {
      expect(issuesFor({ ...VALID_ENV, CONFIRMATIONS: value })).toEqual([
        { key: 'CONFIRMATIONS', message: 'must be a whole number' },
      ]);
    });

    it('accepts CONFIRMATIONS=0 (the reorg chaos test uses it)', () => {
      expect(
        loadConfig(indexerConfigSchema, { ...VALID_ENV, CONFIRMATIONS: '0' }).CONFIRMATIONS,
      ).toBe(0n);
    });

    it.each([
      ['START_BLOCK', '0', 'must be at least 1'],
      ['BATCH_SIZE', '0', 'must be at least 1'],
      ['CHAIN_ID', '0', 'must be a whole number of at least 1'],
      ['CHAIN_ID', '9007199254740993', 'must be a whole number of at least 1'],
      ['POLL_INTERVAL_MS', '50', 'must be a whole number of at least 100'],
      ['REORG_REWIND_BLOCKS', '0', 'must be at least 1'],
      ['SHUTDOWN_TIMEOUT_MS', '50', 'must be a whole number of at least 100'],
      ['METRICS_PORT', '65536', 'must be a port number (0-65535)'],
    ])('rejects %s=%s', (key, value, message) => {
      expect(issuesFor({ ...VALID_ENV, [key]: value })).toEqual([{ key, message }]);
    });
  });

  describe('RPC_HTTP_URL', () => {
    it('rejects a WebSocket URL', () => {
      expect(issuesFor({ ...VALID_ENV, RPC_HTTP_URL: 'wss://rpc.example/ws' })).toEqual([
        { key: 'RPC_HTTP_URL', message: 'must be an http:// or https:// URL' },
      ]);
    });

    it('never puts the URL (it may hold an API key) in the error', () => {
      const issues = issuesFor({ ...VALID_ENV, RPC_HTTP_URL: 'ftp://rpc.example/v2/key-hunter2' });
      expect(JSON.stringify(issues)).not.toContain('hunter2');
    });
  });

  describe('RPC_WS_URL', () => {
    it('is unset when missing or empty (poll-only mode)', () => {
      expect(loadConfig(indexerConfigSchema, VALID_ENV).RPC_WS_URL).toBeUndefined();
      expect(
        loadConfig(indexerConfigSchema, { ...VALID_ENV, RPC_WS_URL: '' }).RPC_WS_URL,
      ).toBeUndefined();
    });

    it.each(['ws://localhost:8545', 'wss://rpc.example/ws/key'])('accepts %s', (url) => {
      expect(loadConfig(indexerConfigSchema, { ...VALID_ENV, RPC_WS_URL: url }).RPC_WS_URL).toBe(
        url,
      );
    });

    it('rejects an http URL without showing it', () => {
      const issues = issuesFor({ ...VALID_ENV, RPC_WS_URL: 'https://rpc.example/v2/key-hunter2' });
      expect(issues).toEqual([{ key: 'RPC_WS_URL', message: 'must be a ws:// or wss:// URL' }]);
      expect(JSON.stringify(issues)).not.toContain('hunter2');
    });
  });

  it('accepts METRICS_PORT=0 (a free port, for tests)', () => {
    expect(loadConfig(indexerConfigSchema, { ...VALID_ENV, METRICS_PORT: '0' }).METRICS_PORT).toBe(
      0,
    );
  });
});
