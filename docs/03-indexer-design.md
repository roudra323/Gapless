# 03 — Indexer Design (mandatory reading before touching `apps/indexer`)

## Core principle

> **The database checkpoint is the source of truth. The WebSocket is only a doorbell.**

The indexer is **pull-based**. It always fetches data with `eth_getLogs` over **HTTP** for an explicit block range, starting at `checkpoint + 1`. The WebSocket `newHeads` subscription only tells the indexer that a new head exists, so it wakes up sooner. If the WebSocket dies, a polling timer does the same job, slightly later.

So a dropped socket can never cause a gap. There's nothing to "replay", because no event data ever arrives over the socket.

## Invariants (never break these)

1. **No gaps:** every block in `[START_BLOCK, last_block]` has been fully processed.
2. **No duplicates:** enforced by the PK `(chain_id, tx_hash, log_index)` plus `INSERT … ON CONFLICT DO NOTHING`.
3. **Atomic progress:** the transfers for a range and the checkpoint update are written in **one DB transaction**. The checkpoint never advances without its data, and data never exists without its checkpoint.
4. **Single writer:** only the process holding the Postgres advisory lock writes, and it writes on the connection that holds the lock.
5. **Confirmed only:** only process blocks `≤ head − CONFIRMATIONS`.

## Components

### HeadTracker (`head/`)

- Keeps `latestHead: bigint` and exposes `waitForChange(signal)`.
- **WS source:** viem `watchBlockNumber` with a `webSocket` transport and reconnect enabled. On each head, update `latestHead` and wake the loop.
- **Poll source:** every `POLL_INTERVAL_MS`, call `getBlockNumber()` over HTTP. This **always runs**, even when the WebSocket is healthy. It's cheap and guarantees progress.
- Sets metrics `gapless_indexer_ws_connected` and `gapless_indexer_ws_reconnects_total`. If socket state isn't directly observable, treat the WebSocket as disconnected when no WS head has arrived for more than `3 × expected block time`.
- If `RPC_WS_URL` is unset, it runs poll-only. That's a valid production mode.

### Leader (`leader/`)

- On start, try `pg_try_advisory_lock(<constant key derived from chain_id + token>)` on a **dedicated connection**, and keep that connection open for the process lifetime.
- Not leader: retry every 5s, stay **not ready**, and don't touch ingestion.
- **Every write (batches and reorg rewinds) runs on that same lock connection**, never on another pool connection. The lock and the write transaction then belong to one Postgres session: if the connection drops, Postgres releases the lock and rolls back the open transaction together, and while the session is alive no other process can take the lock. A write from a former leader (a "zombie" writer) can't commit after a new leader starts. The loop is sequential, so one write connection is enough.
- Attach an `'error'` listener to the held lock client itself. The pool's `'error'` listener only covers idle clients, so without its own listener a dropped socket on the checked-out client crashes the process before leadership can be given up cleanly.
- On any error on the lock connection: destroy it (release it with the error, so the pool doesn't reuse it), set `isLeader = false`, abort the current batch, and go back to retrying. Never reuse that connection.
- This is defense in depth. Kubernetes already runs 1 replica with `Recreate`, but a stuck pod or a manual mistake must never produce two writers.

### Ingestion loop (`ingestion/`)

```
on becoming leader:
  seed the checkpoint row if missing (see "Startup"); checkpoint = read it from the DB
loop while running and isLeader:
  await headTracker.waitForChange(timeout = POLL_INTERVAL_MS)
  target = latestHead - CONFIRMATIONS
  while checkpoint.last_block < target and running:
      from = checkpoint.last_block + 1
      to   = min(target, from + batchSize - 1)
      [anchor, header(to), logs] = one JSON-RPC batch:     # with retry/backoff
          getBlockByNumber(checkpoint.last_block), getBlockByNumber(to),
          getLogs(Transfer, TOKEN_ADDRESS, from, to)
      if anchor.hash != checkpoint.last_block_hash:
          run the reorg rewind (see "Reorg guard"); continue
      blocks = headers for distinct log blocks             (small JSON-RPC batches)
      check consistency (see below); on failure retry the same range, never commit
      in ONE transaction:
          insert transfers ... ON CONFLICT DO NOTHING
          update checkpoint set last_block = to, last_block_hash = hash(to), head_block = latestHead
              where chain_id, token_address match and last_block = from - 1   # fence
      after COMMIT: checkpoint = the updated row; update metrics; adapt batchSize
      after a failed transaction: checkpoint = read it from the DB again
```

**Checkpoint in memory:** the copy in memory is only a cache of the DB row. Read it from the DB when leadership starts, replace it only after `COMMIT` succeeds (from the updated row), and read it again after any failed transaction. Never advance it before the commit.

### Startup (first checkpoint)

On a fresh database there is no checkpoint row, so neither the anchor check nor the fence has anything to match. When leadership starts, before the first batch:

- Insert the row with `last_block = START_BLOCK - 1` and `last_block_hash` = the chain's hash of block `START_BLOCK - 1`, using `INSERT … ON CONFLICT DO NOTHING` (an existing row is never overwritten).
- `START_BLOCK` must be `>= 1`, so `START_BLOCK - 1` is a real block (block 0 is genesis, and a token is deployed in block 1 or later). The config schema enforces it.

Every batch, including the first, then follows the same anchor check and fenced update.

**Batch size adaptation:** start at `BATCH_SIZE`. If the RPC rejects the range (too many results, response size limit, or timeout), halve it (minimum 1) and retry the same `from`. After 10 consecutive successes, double it, back up to `BATCH_SIZE`. Never skip a range because of an error.

### RPC consistency checks

A hosted RPC URL is usually a load balancer in front of several nodes, and they are not always at the same height. A node that is behind can answer `eth_getLogs` for blocks it doesn't have yet with an **empty list instead of an error**. Committing that result would advance the checkpoint over real transfers: a silent gap.

- Request the **anchor** `getBlockByNumber(checkpoint.last_block)`, `getBlockByNumber(to)` and `getLogs(from, to)` in **one JSON-RPC batch** (one HTTP POST), so that on most providers the same node answers all three. A `null` header for `to` means that node does not have the range yet.
- The anchor proves that the node answering `getLogs` builds on the block we already stored. If its hash differs from `checkpoint.last_block_hash`, that is the reorg signal. A separate guard call before the batch is not enough: a reorg (or a different node) between the two calls would let logs from a new fork be committed on top of rows from the old fork, and the checkpoint would then hold the new fork's hash, so the guard would never see a mismatch again.
- Before the transaction, require: the header for `to` exists, and every log's `blockHash` equals the hash in the header fetched for that block.
- Fetch the headers for distinct log blocks in **small batches** (for example 50 calls per POST; check the chosen provider's batch limit). A busy range can have logs in more than a thousand distinct blocks, and providers reject very large batches. A rejected header batch is handled like a rejected `getLogs` range.
- If a check fails, treat it as a transient error: retry the same range with backoff. Never commit a range that failed a check.

A header from one request proves nothing about the node that answered another request, so these checks must not be split across separate calls. They are not airtight against a provider that splits one batch across nodes (see "Known trade-offs").

### Checkpoint fence

The checkpoint update only matches the row if `last_block` still equals `from - 1`, the value this batch started from. If another writer moved the checkpoint, the update changes 0 rows; roll back the whole transaction and stop ingestion. This is defense in depth under the single-writer rules in "Leader". It doesn't cover a writer that sees the same `last_block` again after a reorg rewind (an ABA case), which is why the leader writes on the lock connection.

### Retry policy

- Exponential backoff with full jitter: base 500ms, max 30s, retried indefinitely for transient errors (network, 429, 5xx, timeouts).
- Every RPC call has a timeout. A request that never returns would stop the loop and the liveness heartbeat (see "Health").
- Non-retryable errors (an invalid config, such as a wrong contract address with no code) → log `fatal` and exit non-zero, so Kubernetes restarts the pod and the alert shows the problem.
- Every RPC call records `gapless_rpc_requests_total{method,transport,result}` (`result` = `ok`|`error`|`rate_limited`) and `gapless_rpc_request_duration_seconds{method,transport}`. The metric contract is `docs/09`.

### Reorg guard

Part of every batch request (the anchor, see "RPC consistency checks"):

1. The batch fetches the chain's block at `checkpoint.last_block` together with the range.
2. If its hash equals `checkpoint.last_block_hash`, there's no reorg.
3. If it differs, there's a reorg at or below the checkpoint. Empty blocks can't hide it: a block hash commits to its parent, so any change at or below `last_block` changes the hash of `last_block`. Find the rewind target:
   - Start at `candidate = last_block - REORG_REWIND_BLOCKS` (the minimum rewind depth).
   - Take the newest `transfers` row of this chain and token (`chain_id = $1 AND token_address = $2`) with `block_number <= candidate`, and compare its stored `block_hash` with the chain's hash for that block. On a mismatch, take the next older distinct block and repeat.
   - `rewindTo` = the block of the first row that matches, or `START_BLOCK - 1` if no row matches.
4. In one transaction (on the lock connection):
   - `DELETE FROM transfers WHERE chain_id = $1 AND token_address = $2 AND block_number > rewindTo`
   - set the checkpoint to `rewindTo` (with the chain's current hash of `rewindTo`)
   - increment `gapless_indexer_reorgs_total`, and log `warn` with the old and new hashes.
5. Resume normally. The normal loop re-indexes the rewound range.

**Why the target must be proven:** a block hash commits to its parent, so a stored row whose `block_hash` matches the chain proves that block and every block below it are canonical. Nothing proves the blocks between that row and `candidate`. If the reorg was deeper than `REORG_REWIND_BLOCKS`, the new versions of those blocks may contain transfers never indexed. Stopping at `candidate` would skip them (a gap). Rewinding further only re-reads blocks, which costs a few `getLogs` calls.

`CONFIRMATIONS` makes reorgs rare. The proven rewind makes them safe when they do happen, using the `block_hash` already stored on each row. Don't build per-block hash chains unless an ADR says so.

### Graceful shutdown

- `app.enableShutdownHooks()`. On SIGTERM: set `running = false`, let the **current transaction finish** (don't abort mid-transaction), close the WebSocket, release the advisory lock, close the DB pools, and exit 0.
- If not finished within `SHUTDOWN_TIMEOUT_MS`, exit anyway. The transaction rolls back and the checkpoint is still consistent.
- The pod's `terminationGracePeriodSeconds` must be greater than `SHUTDOWN_TIMEOUT_MS`.

### Health

- **Liveness `/healthz`:** the process has recorded a heartbeat within the last `max(60s, 5 × POLL_INTERVAL_MS)`. This catches a hung event loop or a deadlocked process. It does **not** depend on lag or RPC health; otherwise an RPC outage would cause pointless restart loops.
  - Record the heartbeat on **every loop step that proves the process is working**: each loop cycle, **each retry attempt** (one cycle can retry for minutes during an RPC outage), and **each leader-wait attempt** (a process that isn't leader never runs the loop). Ticking only once per loop cycle would restart a healthy pod during an RPC outage.
- **Readiness `/readyz`:** the process is the leader and the DB is reachable.
- **Lag is a metric and an alert, never a probe.**

## Known trade-offs

Accepted on purpose. Revisit only with an ADR.

- **A provider that splits one JSON-RPC batch across nodes** can still return an empty `getLogs` from a node that is behind, while another node answers the header. The "RPC consistency checks" can't detect that. The backstop is `verify.ts` (the parity check), and the `rpc-lagging-node` chaos test in `docs/06`.
- **Sequential loop:** fetch, then write, then fetch again. A bounded producer/consumer queue would backfill faster, but one token from its deploy block doesn't need it, and the sequential loop is much easier to prove correct under the chaos tests.
- **Rewind cost on a quiet token:** the proven rewind walks back to the newest stored transfer whose hash matches. If the token had no transfers for a long time, a reorg can re-read a long range (for example about 650 `getLogs` calls for one month of Base Sepolia blocks at 2000 blocks per call). Correctness doesn't depend on it, and deep reorgs are rare. A small table of block-hash anchors would bound the cost, but it needs a migration and an ADR (see "Reorg guard").
- **Hard `DELETE` on a reorg:** the only reader of `transfers` is our own API, reading live rows. No downstream consumer needs a reversal event or a soft-deleted row.

## Why not just subscribe to logs over WebSocket?

`eth_subscribe("logs")` delivers events only while connected. After a drop you must work out what you missed, merge the backfill with live events, and deduplicate. That's more code and more failure modes. The pull-based design gets the same latency (the head trigger fires per block) with one code path. See `adr/0001`.

## Verification tool

`apps/indexer/src/verify.ts` (the `pnpm verify` script) compares, for a block range, the count and set of `(tx_hash, log_index)` returned by `getLogs` directly against the DB, then reports gaps and duplicates. It's used by the chaos tests and the demo.
