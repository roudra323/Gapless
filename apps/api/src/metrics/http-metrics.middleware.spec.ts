import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { UNMATCHED_ROUTE } from './api-metrics.js';
import { ALL_ROUTES, routeLabel } from './http-metrics.middleware.js';

const req = (route?: { path?: unknown }) => ({ route }) as unknown as IncomingMessage;

describe('routeLabel', () => {
  it('uses the route template of a matched route', () => {
    expect(routeLabel(req({ path: '/v1/addresses/:address/transfers' }))).toBe(
      '/v1/addresses/:address/transfers',
    );
  });

  it.each([
    ['no route', req()],
    ['the middleware pattern', req({ path: ALL_ROUTES })],
    ['a non-string path', req({ path: /regex/ })],
  ])('is unmatched for %s', (_name, request) => {
    expect(routeLabel(request)).toBe(UNMATCHED_ROUTE);
  });
});
