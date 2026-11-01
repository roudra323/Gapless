import { createPublicClient, http, type PublicClient } from 'viem';

/** Per-request timeout. A request that never returns would stop the loop (docs/03 "Retry policy"). */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * The most JSON-RPC calls in one HTTP POST. Larger batches are split into several POSTs.
 * Providers reject very large batches (docs/03 "RPC consistency checks").
 */
export const RPC_BATCH_SIZE = 50;

export type RpcClientOptions = {
  /** The JSON-RPC HTTP URL. Secret: it may contain a provider API key (see `redactRpcUrl`). */
  readonly url: string;
  readonly timeoutMs?: number;
};

/**
 * A viem public client over HTTP, set up for the indexer's rules (docs/03):
 *
 * - `retryCount: 0`: the caller owns retries (backoff with jitter, a heartbeat on every attempt,
 *   batch-size halving). viem's default of 3 hidden retries would bypass all of that.
 * - `cacheTime: 0`: viem caches `getBlockNumber` for up to 4 seconds by default, which would
 *   return a stale head.
 * - `batch`: calls made in the same event-loop tick go out in one HTTP POST, so on most providers
 *   one node answers the anchor, the `to` header and `getLogs` together.
 */
export function createRpcClient({
  url,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
}: RpcClientOptions): PublicClient {
  return createPublicClient({
    cacheTime: 0,
    transport: http(url, {
      batch: { batchSize: RPC_BATCH_SIZE, wait: 0 },
      retryCount: 0,
      timeout: timeoutMs,
    }),
  });
}
