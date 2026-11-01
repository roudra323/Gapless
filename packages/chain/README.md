# `packages/chain` — `@gapless/chain`

The viem HTTP client, the `Transfer` ABI and decoder, error redaction, and the `normalizeAddress` / `toChecksum` helpers. Framework-free: functions take plain values, not app config.

- **Built in:** Phase 3 (HTTP only; the WebSocket client comes in Phase 4)
- **Read first:** `docs/03-indexer-design.md` ("RPC consistency checks", "Retry policy"), `docs/05-coding-conventions.md` (blockchain values)

## Usage

```ts
import { createRpcClient, decodeTransferLog, redactRpcUrl } from '@gapless/chain';

const client = createRpcClient({ url: config.RPC_HTTP_URL });
try {
  // ...
} catch (err) {
  // Classify `err` first (retryable or not), then redact it for the log.
  logger.error({ err: redactRpcUrl(err, config.RPC_HTTP_URL) }, 'rpc call failed');
}
```

| Export                    | Purpose                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `normalizeAddress`        | Validates an address and returns it lowercase (storage, comparison).                                                     |
| `toChecksum`              | Validates an address and returns it EIP-55 checksummed (API responses).                                                  |
| `createRpcClient`         | viem public client over HTTP: no hidden retries, no block-number cache, batched POSTs, a request timeout.                |
| `DEFAULT_RPC_TIMEOUT_MS`  | 10 000 ms, the per-request timeout.                                                                                      |
| `RPC_BATCH_SIZE`          | 50, the most JSON-RPC calls in one POST.                                                                                 |
| `classifyRpcError`        | `range-rejected` (the provider refused the range size: halve the batch) or `transient` (retry later).                    |
| `subscribeNewHeads`       | `newHeads` over a WebSocket, as a doorbell only. viem's reconnect is off: the caller re-subscribes with its own backoff. |
| `redactRpcUrl`            | Copies an error with the URL's path, query and userinfo removed from every message, stack, field and cause.              |
| `transferEventAbi`        | The ERC-20 `Transfer` event ABI (`as const`).                                                                            |
| `TRANSFER_TOPIC`          | The `Transfer(address,address,uint256)` selector, the first topic of every Transfer log.                                 |
| `decodeTransferLog`       | Decodes one raw log to `{ from, to, value }` (lowercase addresses, `bigint` value), or throws.                           |
| `InvalidTransferLogError` | Thrown for a log that isn't a standard ERC-20 Transfer. Not retryable.                                                   |

## Rules

- **Validation is strict.** A mixed-case address with a wrong checksum is rejected by both helpers. viem's `getAddress` alone accepts it and returns a corrected checksum, which hides a typo.
- **Never let viem decode logs inside `getLogs`.** With `strict: false` (viem's default), it returns logs with partial or empty `args`; with `strict: true`, it drops logs it can't decode. Both lose data. Fetch raw logs and call `decodeTransferLog` on each one. It checks the exact shape (3 topics, zero-padded address topics, one 32-byte data word), because viem's decoder ignores extra topics and data, and an ERC-721 `Transfer` has the same first topic.
- **The client never retries.** viem retries 3 times by default. The indexer owns retries (docs/03 "Retry policy"), so the client sets `retryCount: 0`.
- **Classify, then redact.** `classifyRpcError` reads viem's error classes and fields (`TimeoutError`, `status`, `code`) through the `cause` chain. The copy from `redactRpcUrl` is a plain `Error`, so classify the original.
- **Redact before logging.** viem puts the request URL in its error messages and strips only `user:pass@`, so a key in the path (`/v2/<key>`) reaches the logs. The logger's `redact` option matches field names, not text inside a message.
