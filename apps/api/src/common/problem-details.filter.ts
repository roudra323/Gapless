import { STATUS_CODES } from 'node:http';

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';

import { DomainError, ERROR_CODE, type ErrorCode } from './domain-error.js';

/** The RFC 9457 media type for error bodies (docs/02 "Errors"). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The HTTP status for each error code. A `Record` over `ErrorCode`, so adding a code without a
 * status is a compile error.
 */
export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_ADDRESS: 400,
  INVALID_CURSOR: 400,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** An RFC 9457 problem details body, plus our `errorCode` extension member. */
export type ProblemDetails = {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly errorCode: ErrorCode;
};

/** The fixed text for errors whose own message is not safe or not useful to show. */
const SAFE_DETAIL: Readonly<Record<ErrorCode, string>> = {
  INVALID_REQUEST: 'The request is not valid.',
  INVALID_ADDRESS: 'The address is not valid.',
  INVALID_CURSOR: 'The cursor is not valid.',
  NOT_FOUND: 'No route matches this method and path.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Try again later.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

/**
 * Turns any thrown value into a problem details body. Pure, so it is tested without HTTP.
 *
 * - `DomainError`: its code and its message. We write those messages, so they are safe to show.
 * - A Nest `HttpException` below 500 (for example the router's 404, or a failed schema check):
 *   `NOT_FOUND` or `INVALID_REQUEST` with a fixed detail, because Nest's text can echo the input.
 * - Anything else: 500 `INTERNAL_ERROR` with a fixed detail. No message, stack, or SQL leaves.
 */
export function toProblem(exception: unknown): ProblemDetails {
  if (exception instanceof DomainError) {
    return problem(exception.code, exception.message);
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return problem(ERROR_CODE.NOT_FOUND);
    if (status >= 400 && status < 500) {
      return { ...problem(ERROR_CODE.INVALID_REQUEST), status, title: titleFor(status) };
    }
  }
  return problem(ERROR_CODE.INTERNAL_ERROR);
}

function problem(code: ErrorCode, detail = SAFE_DETAIL[code]): ProblemDetails {
  const status = STATUS_BY_CODE[code];
  return { type: 'about:blank', title: titleFor(status), status, detail, errorCode: code };
}

/** With `type: about:blank`, RFC 9457 says the title is the status phrase ("Bad Request"). */
function titleFor(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/**
 * The one global exception filter (docs/05 "Errors"). Every error leaves as
 * `application/problem+json`. A 5xx is logged with the full error; the client never sees it.
 */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
  // Value imports: Nest resolves these from the constructor types (docs/05).
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ProblemDetailsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = toProblem(exception);
    if (body.status >= 500) {
      // A 4xx is the client's mistake and already shows in the request log line.
      this.logger.error({ err: exception, errorCode: body.errorCode }, 'request failed');
    }

    const { httpAdapter } = this.adapterHost;
    const res: unknown = host.switchToHttp().getResponse();
    // The response may be half written (for example a stream that failed). Then nothing more can
    // be sent; the log line above is the record.
    if (httpAdapter.isHeadersSent(res)) return;
    httpAdapter.setHeader(res, 'content-type', PROBLEM_CONTENT_TYPE);
    httpAdapter.reply(res, body, body.status);
  }
}
