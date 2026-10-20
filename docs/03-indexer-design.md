# 03 — Indexer Design (mandatory reading before touching `apps/indexer`)

## Core principle

> **The database checkpoint is the source of truth. The WebSocket is only a doorbell.**

The indexer is **pull-based**. It always fetches data with `eth_getLogs` over **HTTP** for an explicit block range, starting at `checkpoint + 1`. The WebSocket `newHeads` subscription only tells the indexer that a new head exists, so it wakes up sooner. If the WebSocket dies, a polling timer does the same job, slightly later.

So a dropped socket can never cause a gap. There's nothing to "replay", because no event data ever arrives over the socket.

## Invariants (never break these)

1. **No gaps:** every block in `[START_BLOCK, last_block]` has been fully processed.
2. **No duplicates:** enforced by the PK `(chain_id, tx_hash, log_index)` plus `INSERT … ON CONFLICT DO NOTHING`.
3. **Atomic progress:** the transfers for a range and the checkpoint update are written in **one DB transaction**. The checkpoint never advances without its data, and data never exists without its checkpoint.
4. **Single writer:** only the process holding the Postgres advisory lock writes.
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
- If the lock connection drops, stop ingestion immediately and go back to retrying.
- This is defense in depth. Kubernetes already runs 1 replica with `Recreate`, but a stuck pod or a manual mistake must never produce two writers.

### Ingestion loop (`ingestion/`)

```
loop while running and isLeader:
  await headTracker.waitForChange(timeout = POLL_INTERVAL_MS)
  target = latestHead - CONFIRMATIONS
  while checkpoint.last_block < target and running:
      await reorgGuard.check()                       # may rewind checkpoint
      from = checkpoint.last_block + 1
      to   = min(target, from + batchSize - 1)
      logs = getLogs(Transfer, TOKEN_ADDRESS, from, to)   # with retry/backoff
      blocks = fetch headers for distinct log blocks + block `to`  (JSON-RPC batch)
      in ONE transaction:
          insert transfers ... ON CONFLICT DO NOTHING
          update checkpoint set last_block = to, last_block_hash = hash(to), head_block = latestHead
      update metrics; adapt batchSize
```

**Batch size adaptation:** start at `BATCH_SIZE`. If the RPC rejects the range (too many results, response size limit, or timeout), halve it (minimum 1) and retry the same `from`. After 10 consecutive successes, double it, back up to `BATCH_SIZE`. Never skip a range because of an error.

### Retry policy

- Exponential backoff with full jitter: base 500ms, max 30s, retried indefinitely for transient errors (network, 429, 5xx, timeouts).
- Non-retryable errors (an invalid config, such as a wrong contract address with no code) → log `fatal` and exit non-zero, so Kubernetes restarts the pod and the alert shows the problem.
- Every RPC call records `gapless_rpc_requests_total{method,transport,result}` (`result` = `ok`|`error`|`rate_limited`) and `gapless_rpc_request_duration_seconds{method,transport}`. The metric contract is `docs/09`.

### Reorg guard

Before each batch:

1. Fetch the chain's block at `checkpoint.last_block`.
2. If its hash equals `checkpoint.last_block_hash`, there's no reorg.
3. If it differs, there's a reorg at or below the checkpoint. In one transaction:
   - `rewindTo = max(START_BLOCK - 1, last_block - REORG_REWIND_BLOCKS)`
   - `DELETE FROM transfers WHERE chain_id = $1 AND block_number > rewindTo`
   - set the checkpoint to `rewindTo` (with the chain's current hash of `rewindTo`)
   - increment `gapless_indexer_reorgs_total`, and log `warn` with the old and new hashes.
4. Resume normally. The normal loop re-indexes the rewound range.

`CONFIRMATIONS` makes reorgs rare. The rewind window makes them safe when they do happen. Keep this simple rewind approach. Don't build per-block hash chains unless an ADR says so.

### Graceful shutdown

- `app.enableShutdownHooks()`. On SIGTERM: set `running = false`, let the **current transaction finish** (don't abort mid-transaction), close the WebSocket, release the advisory lock, close the DB pools, and exit 0.
- If not finished within `SHUTDOWN_TIMEOUT_MS`, exit anyway. The transaction rolls back and the checkpoint is still consistent.
- The pod's `terminationGracePeriodSeconds` must be greater than `SHUTDOWN_TIMEOUT_MS`.

### Health

- **Liveness `/healthz`:** the ingestion loop has ticked within the last `max(60s, 5 × POLL_INTERVAL_MS)`. This catches a hung event loop or a deadlocked process. It does **not** depend on lag or RPC health; otherwise an RPC outage would cause pointless restart loops.
- **Readiness `/readyz`:** the process is the leader and the DB is reachable.
- **Lag is a metric and an alert, never a probe.**

## Why not just subscribe to logs over WebSocket?

`eth_subscribe("logs")` delivers events only while connected. After a drop you must work out what you missed, merge the backfill with live events, and deduplicate. That's more code and more failure modes. The pull-based design gets the same latency (the head trigger fires per block) with one code path. See `adr/0001`.

## Verification tool

`apps/indexer/src/verify.ts` (the `pnpm verify` script) compares, for a block range, the count and set of `(tx_hash, log_index)` returned by `getLogs` directly against the DB, then reports gaps and duplicates. It's used by the chaos tests and the demo.
