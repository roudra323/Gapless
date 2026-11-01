import { createServer, type IncomingMessage, type Server } from 'node:http';

/** One JSON-RPC call, as it arrives (alone or inside a batch). */
export type RpcCall = {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: readonly unknown[];
};

/** A replacement answer for one call: a result, or a JSON-RPC error. */
export type CallAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** A fault for the whole HTTP request, before any call is looked at. */
export type RequestFault = 429 | 500 | 'reset';

export type RpcProxyHooks = {
  /** Called once per HTTP request, with its 0-based number. Return a fault to fail it. */
  failRequest?: (requestNumber: number) => RequestFault | undefined;
  /** Called per call. Return an answer to replace the upstream one, or `undefined` to forward. */
  interceptCall?: (call: RpcCall) => CallAnswer | undefined;
};

export type RpcProxy = {
  /** The proxy's base URL, plus `pathSuffix` (for example a fake API key path). */
  readonly url: string;
  /** Replace the hooks while the proxy runs. */
  readonly setHooks: (hooks: RpcProxyHooks) => void;
  readonly stats: { requests: number; faults: number; intercepted: number };
  readonly close: () => Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * A small JSON-RPC proxy in front of anvil, for the chaos tests (docs/06 "Indexer integration
 * and chaos tests"). It handles single calls and batches. The tests use its hooks to fail
 * requests (a flaky provider), answer some calls themselves (a node that lags), or reject large
 * ranges (a provider limit). Everything else is forwarded unchanged with `fetch`.
 */
export async function startRpcProxy(
  upstreamUrl: string,
  initialHooks: RpcProxyHooks = {},
  pathSuffix = '',
): Promise<RpcProxy> {
  let hooks = initialHooks;
  const stats = { requests: 0, faults: 0, intercepted: 0 };

  const forward = async (calls: readonly RpcCall[]): Promise<Map<RpcCall['id'], unknown>> => {
    const answers = new Map<RpcCall['id'], unknown>();
    if (calls.length === 0) return answers;
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls),
    });
    const body = (await response.json()) as { id: RpcCall['id'] }[];
    for (const item of body) answers.set(item.id, item);
    return answers;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const number = stats.requests++;
      const body = await readBody(req);
      const fault = hooks.failRequest?.(number);
      if (fault !== undefined) {
        stats.faults += 1;
        if (fault === 'reset') {
          req.socket.destroy();
          return;
        }
        res.writeHead(fault, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: fault === 429 ? 'rate limited' : 'internal error' }));
        return;
      }

      const parsed = JSON.parse(body) as RpcCall | RpcCall[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      const own = new Map<RpcCall['id'], unknown>();
      const rest: RpcCall[] = [];
      for (const call of calls) {
        const answer = hooks.interceptCall?.(call);
        if (answer === undefined) {
          rest.push(call);
        } else {
          stats.intercepted += 1;
          own.set(call.id, { jsonrpc: '2.0', id: call.id, ...answer });
        }
      }
      const upstream = await forward(rest);
      const answers = calls.map((call) => own.get(call.id) ?? upstream.get(call.id));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no proxy address');

  return {
    url: `http://127.0.0.1:${address.port}${pathSuffix}`,
    setHooks: (next) => {
      hooks = next;
    },
    stats,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The block number of a `eth_getBlockByNumber` call, or `undefined` for a tag such as `latest`. */
export function blockParam(call: RpcCall): bigint | undefined {
  const value = call.params?.[0];
  return typeof value === 'string' && value.startsWith('0x') ? BigInt(value) : undefined;
}

/** The `[fromBlock, toBlock]` of a `eth_getLogs` call. */
export function logsRange(call: RpcCall): readonly [bigint, bigint] | undefined {
  const filter = call.params?.[0] as { fromBlock?: string; toBlock?: string } | undefined;
  if (filter?.fromBlock === undefined || filter.toBlock === undefined) return undefined;
  return [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
}
