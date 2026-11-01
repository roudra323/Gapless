import { normalizeAddress } from '@gapless/chain';
import { isAddress, zeroAddress } from 'viem';
import { z } from 'zod';

/** Message for a missing key, or `reason` for a present but invalid one. Never includes the value. */
function requiredOr(reason: string) {
  return (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : reason);
}

/**
 * Decimal digits only. Not `z.coerce`: it turns an empty string into 0 and accepts `1e3` and
 * padded values, so `CONFIRMATIONS=` would silently mean zero confirmations.
 */
const digits = z.string({ error: requiredOr('must be a whole number') }).regex(/^\d+$/, {
  error: 'must be a whole number',
});

/** A whole number of at least `min`, as `bigint` (block numbers and block counts, see docs/05). */
function bigintAtLeast(min: bigint) {
  return digits
    .transform((value) => BigInt(value))
    .refine((value) => value >= min, { error: `must be at least ${min}` });
}

/** A whole number of at least `min`, as `number` (chain IDs, durations). */
function intAtLeast(min: number) {
  return digits
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value >= min, {
      error: `must be a whole number of at least ${min}`,
    });
}

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

/**
 * An EIP-55 checksummed or all-lowercase address, returned lowercase (addresses are stored
 * lowercase, see docs/05 "Blockchain values"). A mixed-case address with a wrong checksum is
 * rejected, because that is usually a typo.
 */
const address = z
  .string({ error: requiredOr('must be an address') })
  .refine((value) => isAddress(value), {
    error: 'must be a 0x address (lowercase or EIP-55 checksummed)',
  })
  .transform((value) => normalizeAddress(value));

/**
 * A contract address. The zero address (the `.env.example` placeholder) can never hold code, and
 * `getLogs` for it returns an empty list instead of an error, so the indexer would advance over
 * every block and store nothing. Addresses with no code are caught at startup (docs/03).
 */
const contractAddress = address.refine((value) => value !== zeroAddress, {
  error: 'must not be the zero address (set it after deploying the token)',
});

/** The chain and token every process works on (docs/02 "Configuration"). */
export const chainConfigSchema = z.object({
  CHAIN_ID: intAtLeast(1),
  TOKEN_ADDRESS: contractAddress,
});

export type ChainConfig = z.infer<typeof chainConfigSchema>;

/** A TCP port. 0 asks the OS for a free port (used by tests). */
const port = intAtLeast(0).refine((value) => value <= 65_535, {
  error: 'must be a port number (0-65535)',
});

/**
 * An optional `ws://` or `wss://` URL. An empty value means unset, because `.env.example` has
 * `RPC_WS_URL=` (poll-only mode, docs/03 "HeadTracker").
 */
const optionalWsUrl = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value))
  .pipe(z.url({ protocol: /^wss?$/, error: 'must be a ws:// or wss:// URL' }).optional());

/** Env for the indexer (docs/02 "Configuration"). */
export const indexerConfigSchema = migrateConfigSchema.extend(chainConfigSchema.shape).extend({
  /** Secret: may contain a provider API key. The logger redacts it (packages/observability). */
  RPC_HTTP_URL: z.url({
    protocol: /^https?$/,
    error: requiredOr('must be an http:// or https:// URL'),
  }),
  /** At least 1, so `START_BLOCK - 1` is a real block for the first checkpoint (docs/03 "Startup"). */
  START_BLOCK: bigintAtLeast(1n),
  /** 0 is allowed: the reorg chaos test runs with no confirmations (docs/06). */
  CONFIRMATIONS: bigintAtLeast(0n).default(5n),
  BATCH_SIZE: bigintAtLeast(1n).default(2000n),
  POLL_INTERVAL_MS: intAtLeast(100).default(4000),
  /** Secret, optional: a WebSocket URL that only wakes the loop sooner (docs/03 "HeadTracker"). */
  RPC_WS_URL: optionalWsUrl,
  /** The minimum rewind depth on a reorg (docs/03 "Reorg guard"). */
  REORG_REWIND_BLOCKS: bigintAtLeast(1n).default(64n),
  /** Must be less than the pod's `terminationGracePeriodSeconds` (docs/03 "Graceful shutdown"). */
  SHUTDOWN_TIMEOUT_MS: intAtLeast(100).default(20_000),
  /** The internal port for `/healthz` and `/readyz` (and `/metrics` from Phase 6). */
  METRICS_PORT: port.default(9464),
});

export type IndexerConfig = z.infer<typeof indexerConfigSchema>;
