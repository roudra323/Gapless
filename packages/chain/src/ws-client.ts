import { createPublicClient, hexToBigInt, type Hex, webSocket } from 'viem';

import { DEFAULT_RPC_TIMEOUT_MS } from './rpc-client.js';

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
};

export type NewHeadsSubscription = {
  /** Closes the socket. Safe to call more than once. Await it before subscribing again. */
  readonly close: () => Promise<void>;
};

/**
 * Subscribes to `newHeads` over a WebSocket (docs/03 "HeadTracker"). The socket is a doorbell
 * only: it carries block numbers, never event data.
 *
 * viem's own reconnect is off (`reconnect: false`, `retryCount: 0`): the caller owns the retries,
 * with the same backoff as every other RPC call (docs/03 "Retry policy"). viem's default would
 * also give up after 5 attempts.
 *
 * @throws when the socket can't be opened or `eth_subscribe` fails.
 */
export async function subscribeNewHeads({
  url,
  onHead,
  onError,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
}: NewHeadsOptions): Promise<NewHeadsSubscription> {
  const client = createPublicClient({
    transport: webSocket(url, { reconnect: false, retryCount: 0, timeout: timeoutMs }),
  });
  const { transport } = client;

  let ready = false;
  let closed = false;
  let reported = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // getRpcClient returns viem's cached socket client. Closing it also removes it from the
      // cache, so the next subscribe to the same URL opens a new socket.
      (await transport.getRpcClient()).close();
    } catch {
      // The socket could not be opened, so there is nothing to close.
    }
  };

  try {
    await transport.subscribe({
      params: ['newHeads'],
      onData: (data: { result?: { number?: Hex } }) => {
        const number = data.result?.number;
        if (!closed && number !== undefined) onHead(hexToBigInt(number));
      },
      onError: (err: unknown) => {
        // Before `ready`, the same error rejects `subscribe` below, so it is not reported twice.
        // A failing socket reports both an error and a close: tell the caller once.
        if (!ready || closed || reported) return;
        reported = true;
        onError(err);
      },
    });
  } catch (err) {
    await close();
    throw err;
  }
  ready = true;
  return { close };
}
