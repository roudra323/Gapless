import type { Server } from 'node:http';

/**
 * How long the API keeps an idle keep-alive connection open. It must be longer than the
 * upstream idle timeout of every proxy in front of it (Envoy: `gateway.upstreamIdleTimeout`
 * in the chart, 60 s), so the proxy always closes an idle connection first.
 *
 * Node's default is 5 s. Envoy keeps idle upstream connections for 1 hour by default, so Node
 * closed them, and a request that Envoy sent on a connection at the moment Node closed it got a
 * 503 `UC` ("upstream connection termination"). See docs/07 "Gateway".
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Node's limit for receiving a request's headers. Kept above the keep-alive timeout, so an idle
 * connection is never closed by the headers timer before the keep-alive timer.
 */
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 1_000;

/** Sets the connection timeouts on the API's HTTP server. Call it before `listen`. */
export function configureHttpServer(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
