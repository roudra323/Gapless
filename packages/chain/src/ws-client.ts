import { createPublicClient, hexToBigInt, type Hex, webSocket } from 'viem';

import { DEFAULT_RPC_TIMEOUT_MS } from './rpc-client.js';
import { observeRpcCall, type RpcCallObserver } from './rpc-observer.js';

export type NewHeadsOptions = {
  /** The JSON-RPC WebSocket URL. Secret: it may contain a provider API key (see `redactRpcUrl`). */
  readonly url: string;
  /** Called with the block number of each new head. */
  readonly onHead: (block: bigint) => void;
  /**
   * Called once when the subscription stops working after it was set up (the socket closed or
   * failed). The subscription is dead after this; call `close` and subscribe again.
   */
  readonly onError: (err: unknown) => void;
  readonly timeoutMs?: number;
  /** Gets the `eth_subscribe` call, for the RPC metrics (docs/09). */
  readonly onCall?: RpcCallObserver;
};

export type NewHeadsSubscription = {
  /** Closes the socket. Safe to call more than once. Await it before subscribing again. */
  readonly close: () => Promise<void>;
};

/** Thrown when opening the socket and `eth_subscribe` take longer than `timeoutMs`. */
export class WebSocketSubscribeTimeoutError extends Error {
  override readonly name = 'WebSocketSubscribeTimeoutError';

  constructor(timeoutMs: number) {
    super(`opening the WebSocket and eth_subscribe took more than ${timeoutMs} ms`);
  }
}

/**
 * Subscribes to `newHeads` over a WebSocket (docs/03 "HeadTracker"). The socket is a doorbell
 * only: it carries block numbers, never event data.
 *
 * viem's own reconnect is off (`reconnect: false`, `retryCount: 0`): the caller owns the retries,
 * with the same backoff as every other RPC call (docs/03 "Retry policy"). viem's default would
 * also give up after 5 attempts.
 *
 * Opening the socket and `eth_subscribe` together must finish within `timeoutMs`. viem has no
 * timeout for either: on a network that drops packets (or a socket whose handshake answer never
 * arrives) the call would wait forever, so the caller would never reconnect and shutdown would
 * hang.
 *
 * @throws when the socket can't be opened, `eth_subscribe` fails, or both take too long
 * ({@link WebSocketSubscribeTimeoutError}).
 */
export async function subscribeNewHeads({
  url,
  onHead,
  onError,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  onCall,
}: NewHeadsOptions): Promise<NewHeadsSubscription> {
  const client = createPublicClient({
    transport: webSocket(url, { reconnect: false, retryCount: 0, timeout: timeoutMs }),
  });
  const { transport } = client;
  // Starts opening the socket. This exact client is the one to close: viem caches socket clients
  // by URL, so a later `getRpcClient()` could return (or open) another one.
  const opening = transport.getRpcClient();

  let ready = false;
  let closed = false;
  let reported = false;
  const close = (): Promise<void> => {
    if (!closed) {
      closed = true;
      // Not awaited on purpose: a socket that is still opening (after a timeout) is closed as soon
      // as it opens, and one that fails to open has nothing to close. Never wait here for an open
      // that may never finish.
      void opening.then(
        (rpcClient) => rpcClient.close(),
        () => undefined,
      );
    }
    return Promise.resolve();
  };

  try {
    await observeRpcCall(onCall, 'eth_subscribe', 'ws', () =>
      withTimeout(
        timeoutMs,
        (async () => {
          await opening;
          await transport.subscribe({
            params: ['newHeads'],
            onData: (data: { result?: { number?: Hex } }) => {
              const number = data.result?.number;
              if (!closed && number !== undefined) onHead(hexToBigInt(number));
            },
            onError: (err: unknown) => {
              // Before `ready`, the same error rejects `subscribe` above, so it is not reported
              // twice. A failing socket reports both an error and a close: tell the caller once.
              if (!ready || closed || reported) return;
              reported = true;
              onError(err);
            },
          });
        })(),
      ),
    );
  } catch (err) {
    await close();
    throw err;
  }
  ready = true;
  return { close };
}

/** `promise`, or a {@link WebSocketSubscribeTimeoutError} after `timeoutMs`. */
async function withTimeout<T>(timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WebSocketSubscribeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing promise may reject later (the open fails after the timeout): not an error here.
    promise.catch(() => undefined);
  }
}
