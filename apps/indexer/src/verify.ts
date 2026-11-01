// `pnpm verify [--from N] [--to N] [--chunk N]`: compares the DB with `eth_getLogs` for a block
// range and reports gaps and duplicates (docs/03 "Verification tool").
// Exit code 0 = parity; 2 = mismatch; 1 = invalid input or a failed check.
import { parseArgs } from 'node:util';

import { createRpcClient, redactRpcUrl } from '@gapless/chain';
import { ConfigError, type IndexerConfig, indexerConfigSchema, loadConfig } from '@gapless/config';
import { createDb } from '@gapless/db';
import { createLogger } from '@gapless/observability';

import { SERVICE_NAME } from './app.module.js';
import { IndexerRepository } from './ingestion/indexer.repository.js';
import { verifyRange } from './verify/verify-range.js';

const USAGE = 'usage: pnpm verify [--from <block>] [--to <block>] [--chunk <blocks>]';

/** A whole block number, or `undefined` when the option is absent. */
function blockArg(name: string, value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new RangeError(`--${name} must be a whole number. ${USAGE}`);
  return BigInt(value);
}

async function main(): Promise<number> {
  let config: IndexerConfig;
  try {
    config = loadConfig(indexerConfigSchema);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger({ service: SERVICE_NAME, version: 'unknown', level: 'info' }).fatal(
      { issues: err.issues },
      'invalid configuration',
    );
    return 1;
  }
  const logger = createLogger({
    service: SERVICE_NAME,
    version: config.APP_VERSION,
    level: config.LOG_LEVEL,
  });

  const db = createDb({
    url: config.DATABASE_URL,
    applicationName: 'gapless-verify',
    onPoolError: (err) => logger.error({ err }, 'idle database connection failed'),
  });
  try {
    const { values } = parseArgs({
      options: { from: { type: 'string' }, to: { type: 'string' }, chunk: { type: 'string' } },
      strict: true,
    });
    const repository = new IndexerRepository(db.db, config.CHAIN_ID, config.TOKEN_ADDRESS);
    const from = blockArg('from', values.from) ?? config.START_BLOCK;
    const to = blockArg('to', values.to) ?? (await repository.readCheckpoint())?.lastBlock;
    if (to === undefined) {
      logger.error({ chainId: config.CHAIN_ID }, 'no checkpoint yet: pass --to');
      return 1;
    }

    const report = await verifyRange({
      client: createRpcClient({ url: config.RPC_HTTP_URL }),
      store: repository,
      tokenAddress: config.TOKEN_ADDRESS,
      from,
      to,
      chunkSize: blockArg('chunk', values.chunk) ?? config.BATCH_SIZE,
    });
    // Block numbers as decimal strings at the log boundary (docs/05 "Blockchain values").
    const { from: _from, to: _to, ...counts } = report;
    const fields = {
      chainId: config.CHAIN_ID,
      fromBlock: report.from.toString(),
      toBlock: report.to.toString(),
      ...counts,
    };
    if (report.ok) {
      logger.info(fields, 'parity ok');
      return 0;
    }
    logger.error(fields, 'parity failed');
    return 2;
  } catch (err) {
    logger.fatal({ err: redactRpcUrl(err, config.RPC_HTTP_URL) }, 'verify failed');
    return 1;
  } finally {
    await db.close();
  }
}

process.exitCode = await main();
