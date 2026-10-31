import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, type LoggerConfig } from './logger.js';

const CONFIG: LoggerConfig = { service: 'indexer', version: 'abc1234', level: 'info' };

/** A logger that writes into an array, one parsed JSON object per line. */
function captureLogger(config: LoggerConfig = CONFIG) {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { logger: createLogger(config, destination), lines };
}

describe('createLogger', () => {
  it('writes one JSON line with the base fields from docs/09', () => {
    const { logger, lines } = captureLogger();
    logger.info({ fromBlock: 1, toBlock: 10 }, 'batch indexed');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      severity: 'INFO',
      service: 'indexer',
      version: 'abc1234',
      msg: 'batch indexed',
      fromBlock: 1,
      toBlock: 10,
    });
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('hostname');
  });

  it.each([
    ['warn', 'WARNING'],
    ['error', 'ERROR'],
    ['fatal', 'CRITICAL'],
  ] as const)('maps level %s to GCP severity %s', (level, severity) => {
    const { logger, lines } = captureLogger();
    logger[level]('x');
    expect(lines[0]).toMatchObject({ level, severity });
  });

  it('drops entries below the configured level', () => {
    const { logger, lines } = captureLogger({ ...CONFIG, level: 'warn' });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });

  it('redacts secrets at the top level and one level down', () => {
    const { logger, lines } = captureLogger();
    const url = 'postgres://gapless:hunter2@db/gapless';
    logger.info({ DATABASE_URL: url, config: { RPC_HTTP_URL: 'https://rpc/key-hunter2' } }, 'x');

    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
    expect(lines[0]).toMatchObject({
      DATABASE_URL: '[REDACTED]',
      config: { RPC_HTTP_URL: '[REDACTED]' },
    });
  });

  it('serializes the cause chain, with the inner errors of an AggregateError cause', () => {
    const { logger, lines } = captureLogger();
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:1'), new Error('connect ECONNREFUSED 127.0.0.1:1')],
      '',
    );
    logger.error({ err: new Error('Failed query', { cause: refused }) }, 'migrate failed');

    expect(lines[0]?.err).toMatchObject({
      type: 'Error',
      message: 'Failed query',
      cause: {
        type: 'AggregateError',
        aggregateErrors: [
          { message: 'connect ECONNREFUSED ::1:1' },
          { message: 'connect ECONNREFUSED 127.0.0.1:1' },
        ],
      },
    });
  });
});
