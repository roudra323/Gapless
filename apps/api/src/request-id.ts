import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The header that carries the request ID in and out (docs/09 "Logs"). */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Safe characters only, so a client can't put a line break or a huge value into our logs. UUIDs,
 * trace IDs and most gateway IDs match.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The request ID for one request: the incoming `x-request-id` when it is valid (so one ID follows a
 * request through the gateway and the API), else a new UUID. It is also set on the response, so a
 * client can quote it in a bug report.
 */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
