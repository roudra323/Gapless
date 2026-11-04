import { normalizeAddress } from '@gapless/chain';
import { z } from 'zod';

import { DIRECTIONS } from './transfer.js';

/** Page size bounds (docs/02 "API contract"). */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * `limit` as sent in the URL: digits only, then 1–100. Not `z.coerce`, which accepts `''` (0),
 * `1e2` and ` 5` (the same rule as packages/config). A repeated `?limit=1&limit=2` arrives as an
 * array and is rejected.
 */
const limit = z
  .string()
  .regex(/^\d+$/, { error: 'must be a whole number' })
  .transform(Number)
  .pipe(z.int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT);

/**
 * The cursor stays a string here; the service decodes it (`decodeCursor`), so a bad cursor is
 * `INVALID_CURSOR` and not a generic validation error. The length bound stops huge values early.
 */
const cursor = z.string().min(1).max(128).optional();

/** Query of `GET /v1/transfers`. Unknown keys are dropped. */
export const listTransfersQuerySchema = z.object({ limit, cursor });

/** Query of `GET /v1/addresses/:address/transfers`. */
export const addressTransfersQuerySchema = listTransfersQuerySchema.extend({
  direction: z.enum(DIRECTIONS).default('all'),
});

/**
 * The `:address` path value: lowercase or EIP-55 checksummed, returned lowercase for the query
 * (docs/05 "Blockchain values"). A wrong checksum is rejected, because it is usually a typo.
 */
export const addressParamSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeAddress(value);
  } catch {
    ctx.issues.push({ code: 'custom', message: 'must be a 0x address', input: value });
    return z.NEVER;
  }
});

export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;
export type AddressTransfersQuery = z.infer<typeof addressTransfersQuerySchema>;
