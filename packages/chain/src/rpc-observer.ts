import { isRateLimited } from './rpc-error.js';

/** How a JSON-RPC call reached the node. */
export type RpcTransport = 'http' | 'ws';

/** The outcome of one JSON-RPC call (the `result` label of `gapless_rpc_requests_total`). */
export type RpcCallResult = 'ok' | 'error' | 'rate_limited';

/** One finished JSON-RPC call. */
export type RpcCall = {
  /** The JSON-RPC method, such as `eth_getLogs`. A small, fixed set: the indexer's own calls. */
  readonly method: string;
  readonly transport: RpcTransport;
  readonly result: RpcCallResult;
  readonly durationSeconds: number;
};

/**
 * Gets every finished JSON-RPC call (docs/09 "Indexer metrics"). The indexer turns these into
 * Prometheus metrics; this package stays free of Prometheus. It must not throw.
 */
export type RpcCallObserver = (call: RpcCall) => void;

/**
 * Runs `call` and reports it to `observer` (when given) with its time and result. The call's
 * result or error passes through unchanged.
 */
export async function observeRpcCall<T>(
  observer: RpcCallObserver | undefined,
  method: string,
  transport: RpcTransport,
  call: () => Promise<T>,
): Promise<T> {
  if (observer === undefined) return call();
  const start = performance.now();
  let result: RpcCallResult = 'error';
  try {
    const value = await call();
    result = 'ok';
    return value;
  } catch (err) {
    if (isRateLimited(err)) result = 'rate_limited';
    throw err;
  } finally {
    observer({ method, transport, result, durationSeconds: (performance.now() - start) / 1000 });
  }
}
