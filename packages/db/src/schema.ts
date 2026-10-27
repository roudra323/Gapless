import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Lowercase hex only: addresses and hashes are normalized before insert (see docs/05 "Blockchain values").
const ADDRESS_PATTERN = sql.raw(`'^0x[0-9a-f]{40}$'`);
const HASH_PATTERN = sql.raw(`'^0x[0-9a-f]{64}$'`);

/**
 * One row per ERC-20 `Transfer` log. The primary key is the idempotency guarantee:
 * re-inserting the same log is a no-op with `onConflictDoNothing` (see docs/03 "Invariants").
 */
export const transfers = pgTable(
  'transfers',
  {
    chainId: integer('chain_id').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockHash: text('block_hash').notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    tokenAddress: text('token_address').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    // numeric(78,0) holds every uint256 (max is 78 digits). Never a float.
    value: numeric('value', { precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'transfers_pk', columns: [t.chainId, t.txHash, t.logIndex] }),
    // NULLS FIRST is what plain `ORDER BY ... DESC` uses. Drizzle's default for desc() is
    // NULLS LAST, and Postgres then cannot use the index for the sort.
    index('transfers_recent_idx').on(
      t.chainId,
      t.blockNumber.desc().nullsFirst(),
      t.logIndex.desc().nullsFirst(),
    ),
    index('transfers_from_idx').on(
      t.chainId,
      t.fromAddress,
      t.blockNumber.desc().nullsFirst(),
      t.logIndex.desc().nullsFirst(),
    ),
    index('transfers_to_idx').on(
      t.chainId,
      t.toAddress,
      t.blockNumber.desc().nullsFirst(),
      t.logIndex.desc().nullsFirst(),
    ),
    check('transfers_block_hash_format', sql`${t.blockHash} ~ ${HASH_PATTERN}`),
    check('transfers_tx_hash_format', sql`${t.txHash} ~ ${HASH_PATTERN}`),
    check('transfers_token_address_format', sql`${t.tokenAddress} ~ ${ADDRESS_PATTERN}`),
    check('transfers_from_address_format', sql`${t.fromAddress} ~ ${ADDRESS_PATTERN}`),
    check('transfers_to_address_format', sql`${t.toAddress} ~ ${ADDRESS_PATTERN}`),
  ],
);

/**
 * Indexer progress, one row per (chain, token). `last_block` advances only in the same
 * transaction as the transfers it covers (see docs/03 "Atomic progress").
 */
export const indexerCheckpoints = pgTable(
  'indexer_checkpoints',
  {
    chainId: integer('chain_id').notNull(),
    tokenAddress: text('token_address').notNull(),
    lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
    lastBlockHash: text('last_block_hash').notNull(),
    headBlock: bigint('head_block', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'indexer_checkpoints_pk', columns: [t.chainId, t.tokenAddress] }),
    check('indexer_checkpoints_token_address_format', sql`${t.tokenAddress} ~ ${ADDRESS_PATTERN}`),
    check('indexer_checkpoints_last_block_hash_format', sql`${t.lastBlockHash} ~ ${HASH_PATTERN}`),
  ],
);

export type TransferRow = typeof transfers.$inferSelect;
export type NewTransferRow = typeof transfers.$inferInsert;
export type CheckpointRow = typeof indexerCheckpoints.$inferSelect;
