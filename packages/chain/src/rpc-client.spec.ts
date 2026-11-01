import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpRequestError, TimeoutError } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { createRpcClient } from './rpc-client.js';
import { redactRpcUrl } from './rpc-error.js';

type JsonRpcRequest = { id: number; method: string; params?: unknown[] };
type Handler = (body: JsonRpcRequest | JsonRpcRequest[], res: ServerResponse) => void;

/** A local JSON-RPC server that records every POST body. No network, no Docker. */
async function startServer(handler: Handler) {
  const posts: (JsonRpcRequest | JsonRpcRequest[])[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      posts.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { posts, origin: `http://127.0.0.1:${port}` };
}

/** Answers every call with `result(call)`, as one object or a batch array. */
function respondWith(result: (call: JsonRpcRequest) => unknown): Handler {
  const answer = (call: JsonRpcRequest) => ({ jsonrpc: '2.0', id: call.id, result: result(call) });
  return (body, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Every string in an error: messages, stacks, and fields, through `cause` and `errors`. */
function allText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || seen.has(value)) return '';
  seen.add(value);
  return Object.getOwnPropertyNames(value)
    .map((key) => allText((value as Record<string, unknown>)[key], seen))
    .join('\n');
}

/** The error from one `getBlockNumber` call that must fail. */
async function errorFrom(url: string, timeoutMs?: number): Promise<unknown> {
  const client = createRpcClient({ url, timeoutMs });
  try {
    await client.getBlockNumber();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

describe('createRpcClient', () => {
  it('sends calls made in the same tick in one POST (the anchor batch)', async () => {
    const { posts, origin } = await startServer(respondWith(() => '0x1'));
    const client = createRpcClient({ url: origin });

    await Promise.all([
      client.request({ method: 'eth_getBlockByNumber', params: ['0x9', false] }),
      client.request({ method: 'eth_getBlockByNumber', params: ['0x10', false] }),
      client.request({ method: 'eth_getLogs', params: [{ fromBlock: '0xa', toBlock: '0x10' }] }),
    ]);

    expect(posts).toHaveLength(1);
    expect((posts[0] as JsonRpcRequest[]).map((call) => call.method)).toEqual([
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_getLogs',
    ]);
  });

  it('splits a large batch into POSTs of at most 50 calls', async () => {
    const { posts, origin } = await startServer(respondWith(() => '0x1'));
    const client = createRpcClient({ url: origin });

    await Promise.all(Array.from({ length: 120 }, () => client.request({ method: 'eth_chainId' })));

    expect(
      posts.map((body) => (body as JsonRpcRequest[]).length).toSorted((a, b) => a - b),
    ).toEqual([20, 50, 50]);
  });

  it('does not retry: one failed call is one POST', async () => {
    const { posts, origin } = await startServer((_body, res) => {
      res.statusCode = 503;
      res.end('busy');
    });
    const client = createRpcClient({ url: origin });

    await expect(client.request({ method: 'eth_chainId' })).rejects.toBeInstanceOf(
      HttpRequestError,
    );
    expect(posts).toHaveLength(1);
  });

  it('does not cache the block number', async () => {
    let head = 100;
    const { posts, origin } = await startServer(respondWith(() => `0x${(head++).toString(16)}`));
    const client = createRpcClient({ url: origin });

    expect(await client.getBlockNumber()).toBe(100n);
    expect(await client.getBlockNumber()).toBe(101n);
    expect(posts).toHaveLength(2);
  });

  it('times out a request that never returns', async () => {
    const { origin } = await startServer(() => {
      // Never respond.
    });
    const client = createRpcClient({ url: origin, timeoutMs: 50 });

    await expect(client.request({ method: 'eth_chainId' })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('redactRpcUrl with real viem errors', () => {
  const SECRET_PATH = '/v2/key-hunter2?apikey=q-hunter2';

  it('removes the key from an HTTP error and keeps the host and status', async () => {
    const { origin } = await startServer((_body, res) => {
      res.statusCode = 500;
      res.end('internal error');
    });
    const url = `${origin}${SECRET_PATH}`;

    const err = await errorFrom(url);
    expect(allText(err)).toContain('hunter2'); // viem leaks it: the test would catch a regression
    const redacted = redactRpcUrl(err, url);

    expect(allText(redacted)).not.toContain('hunter2');
    // The whole path and query as one placeholder, as viem shows the URL as typed.
    expect(allText(redacted)).toContain(`URL: ${origin}/<redacted>\n`);
    expect(allText(redacted)).toContain('Status: 500');
  });

  it('removes the key from a timeout error', async () => {
    const { origin } = await startServer(() => {
      // Never respond.
    });
    const url = `${origin}${SECRET_PATH}`;

    const err = await errorFrom(url, 50);
    expect(allText(err)).toContain('hunter2');
    expect(allText(redactRpcUrl(err, url))).not.toContain('hunter2');
  });

  it('removes the key from a connection error, through the fetch cause chain', async () => {
    const { origin } = await startServer(respondWith(() => '0x1'));
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    const url = `${origin}${SECRET_PATH}`;

    const err = await errorFrom(url);
    expect(allText(err)).toContain('hunter2');
    expect(allText(redactRpcUrl(err, url))).not.toContain('hunter2');
  });
});
