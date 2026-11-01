import type { DbHandle } from '@gapless/db';

import { waitFor } from './wait-for.js';

export type RowHold = {
  /** Ends the holding transaction, so the blocked writer can go on. */
  readonly release: () => Promise<void>;
};

/**
 * Locks the checkpoint row (`SELECT … FOR UPDATE` in an open transaction). The indexer's next
 * batch then inserts its rows and blocks on the checkpoint UPDATE, inside its own open
 * transaction. That is the exact moment the "kill mid-batch" and "graceful shutdown" tests need,
 * reached without a sleep or a timing guess.
 */
export async function holdCheckpointRow(handle: DbHandle): Promise<RowHold> {
  const client = await handle.pool.connect();
  await client.query('begin');
  await client.query('select * from indexer_checkpoints for update');
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('rollback');
      } finally {
        client.release();
      }
    },
  };
}

/** Waits until an indexer session is blocked on a row lock: a batch transaction is open. */
export async function waitForBlockedWriter(handle: DbHandle, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      const result = await handle.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where application_name = 'gapless-indexer' and wait_event_type = 'Lock'
           and state = 'active' and xact_start is not null`,
      );
      return (result.rows[0]?.n ?? 0) > 0;
    },
    { timeoutMs, description: 'an indexer transaction blocked on the checkpoint row' },
  );
}
