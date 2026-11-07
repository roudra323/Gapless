import type { RpcCall } from '@gapless/chain';
import {
  Counter,
  createMetricsRegistry,
  Gauge,
  Histogram,
  type Registry,
} from '@gapless/observability';

/**
 * Batch time (fetch + write). A healthy batch takes well under a second; the RPC timeout is 10 s
 * and a batch can retry, so the top buckets catch the slow ones.
 */
export const BATCH_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** One RPC call. The RPC timeout is 10 s (docs/03), so nothing lands far above it. */
export const RPC_DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** `result` of `gapless_indexer_batches_total`. */
export type BatchResult = 'ok' | 'error';

/**
 * Every metric of the indexer process, on one registry (docs/09 "Indexer metrics" is the
 * contract; `indexer-metrics.spec.ts` checks the code against that table).
 *
 * The code that counts gets this object by DI and only calls `inc`, `set` and `observe`. The
 * names, types, labels and buckets live here and nowhere else.
 */
export class IndexerMetrics {
  readonly registry: Registry;

  readonly headBlock: Gauge;
  readonly processedBlock: Gauge;
  readonly lagBlocks: Gauge;
  readonly eventsIndexed: Counter;
  readonly batches: Counter<'result'>;
  readonly batchDuration: Histogram;
  readonly batchSizeBlocks: Gauge;
  readonly reorgs: Counter;
  readonly isLeader: Gauge;
  readonly wsConnected: Gauge;
  readonly wsReconnects: Counter;
  readonly lastTick: Gauge;
  readonly rpcRequests: Counter<'method' | 'transport' | 'result'>;
  readonly rpcDuration: Histogram<'method' | 'transport'>;

  /** @param registry a fresh registry by default; tests can pass their own. */
  constructor(registry: Registry = createMetricsRegistry()) {
    this.registry = registry;
    const registers = [registry];

    this.headBlock = new Gauge({
      name: 'gapless_indexer_head_block',
      help: 'Latest chain head seen.',
      registers,
    });
    this.processedBlock = new Gauge({
      name: 'gapless_indexer_processed_block',
      help: 'Checkpoint last_block: every block up to it is indexed.',
      registers,
    });
    this.lagBlocks = new Gauge({
      name: 'gapless_indexer_lag_blocks',
      help: 'Head minus processed block.',
      registers,
    });
    this.eventsIndexed = new Counter({
      name: 'gapless_indexer_events_indexed_total',
      help: 'Transfer rows inserted (rows that already existed are not counted).',
      registers,
    });
    this.batches = new Counter({
      name: 'gapless_indexer_batches_total',
      help: 'Batch outcomes.',
      labelNames: ['result'],
      registers,
    });
    this.batchDuration = new Histogram({
      name: 'gapless_indexer_batch_duration_seconds',
      help: 'Time per batch (fetch + write).',
      buckets: BATCH_DURATION_BUCKETS,
      registers,
    });
    this.batchSizeBlocks = new Gauge({
      name: 'gapless_indexer_batch_size_blocks',
      help: 'Current adaptive batch size.',
      registers,
    });
    this.reorgs = new Counter({
      name: 'gapless_indexer_reorgs_total',
      help: 'Rewinds after a reorg.',
      registers,
    });
    this.isLeader = new Gauge({
      name: 'gapless_indexer_is_leader',
      help: '1 if this process holds the advisory lock and writes.',
      registers,
    });
    this.wsConnected = new Gauge({
      name: 'gapless_indexer_ws_connected',
      help: '1 if the WebSocket head feed is healthy.',
      registers,
    });
    this.wsReconnects = new Counter({
      name: 'gapless_indexer_ws_reconnects_total',
      help: 'WebSocket reconnect attempts.',
      registers,
    });
    this.lastTick = new Gauge({
      name: 'gapless_indexer_last_tick_timestamp_seconds',
      help: 'Unix time of the last loop iteration (heartbeat).',
      registers,
    });
    this.rpcRequests = new Counter({
      name: 'gapless_rpc_requests_total',
      help: 'JSON-RPC requests by method, transport and result.',
      labelNames: ['method', 'transport', 'result'],
      registers,
    });
    this.rpcDuration = new Histogram({
      name: 'gapless_rpc_request_duration_seconds',
      help: 'JSON-RPC request time by method and transport.',
      labelNames: ['method', 'transport'],
      buckets: RPC_DURATION_BUCKETS,
      registers,
    });

    // Start each bounded series at 0, so `rate()` and `increase()` see the first error instead
    // of a series that appears out of nothing.
    for (const result of ['ok', 'error'] satisfies BatchResult[]) this.batches.inc({ result }, 0);
  }

  // The `record*` methods below are what the rest of the indexer calls. They keep the rules
  // (what "lag" is, what a failed batch is) in one place, and the callers never touch a name.
  // Prometheus values are float64: a block number converts exactly up to 2^53, far above any
  // chain height. This is the only place block numbers leave `bigint` (docs/05 "boundaries").

  private head: bigint | undefined;
  private processed: bigint | undefined;

  /** A new chain head (from `HeadTracker`, on the leader and on a standby). */
  recordHead(head: bigint): void {
    this.head = head;
    this.headBlock.set(Number(head));
    this.updateLag();
  }

  /** The checkpoint the leader read, committed or rewound to. */
  recordCheckpoint(lastBlock: bigint): void {
    this.processed = lastBlock;
    this.processedBlock.set(Number(lastBlock));
    this.updateLag();
  }

  /** One planned range fetched and committed. */
  recordBatchIndexed(inserted: number, durationSeconds: number): void {
    this.batches.inc({ result: 'ok' });
    this.eventsIndexed.inc(inserted);
    this.batchDuration.observe(durationSeconds);
  }

  /**
   * One planned range that did not commit: the RPC refused it, a reorg was found, or an RPC or
   * database call failed. A shutdown or a lost lock is not a failed batch.
   */
  recordBatchFailed(): void {
    this.batches.inc({ result: 'error' });
  }

  recordBatchSize(blocks: bigint): void {
    this.batchSizeBlocks.set(Number(blocks));
  }

  /** One rewind after a reorg, done. */
  recordReorg(): void {
    this.reorgs.inc();
  }

  recordLeader(isLeader: boolean): void {
    this.isLeader.set(isLeader ? 1 : 0);
  }

  /** The WS head feed turned healthy (`true`) or not; poll-only mode stays `false`. */
  recordWsConnected(connected: boolean): void {
    this.wsConnected.set(connected ? 1 : 0);
  }

  /** One WebSocket subscribe attempt after the first (after a loss, a failed connect or a stall). */
  recordWsReconnect(): void {
    this.wsReconnects.inc();
  }

  /** One finished JSON-RPC call (the `onCall` observer of `createRpcClient`, packages/chain). */
  recordRpcCall({ method, transport, result, durationSeconds }: RpcCall): void {
    this.rpcRequests.inc({ method, transport, result });
    this.rpcDuration.observe({ method, transport }, durationSeconds);
  }

  /** A heartbeat at `atMs` (epoch milliseconds). */
  recordTick(atMs: number): void {
    this.lastTick.set(atMs / 1000);
  }

  /**
   * Head minus processed, never below 0 (a rewind or a fresh seed can put the checkpoint above
   * the head seen so far). Only the leader knows both values, so a standby keeps 0.
   */
  private updateLag(): void {
    if (this.head === undefined || this.processed === undefined) return;
    this.lagBlocks.set(this.head > this.processed ? Number(this.head - this.processed) : 0);
  }
}
