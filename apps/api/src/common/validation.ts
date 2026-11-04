import {
  type ParameterDecoratorOptions,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';

import { DomainError, type ErrorCode } from './domain-error.js';

// The Standard Schema types, taken from Nest so the API needs no direct `@standard-schema/spec`
// dependency (pnpm only lets a package import what its package.json lists).
type Schema = NonNullable<ParameterDecoratorOptions['schema']>;
type Issues = Parameters<NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>>[0];

/** The fixed text for each validation code. Zod's own issue texts are added for INVALID_REQUEST. */
const MESSAGE: Readonly<Partial<Record<ErrorCode, string>>> = {
  INVALID_ADDRESS: 'The address is not valid.',
};

/**
 * Options for `@Query(...)` / `@Param(...)` that validate the value with a Zod schema (Nest 12
 * Standard Schema support, docs/05 "Validation") and fail with a `DomainError` of `code`.
 *
 * Each parameter gets its own pipe, so a bad `:address` is `INVALID_ADDRESS` while a bad `limit` is
 * `INVALID_REQUEST`. A global pipe could not tell them apart.
 */
export function validated(schema: Schema, code: ErrorCode): ParameterDecoratorOptions {
  return {
    schema,
    pipes: [
      new StandardSchemaValidationPipe({
        exceptionFactory: (issues) => new DomainError(code, MESSAGE[code] ?? describe(issues)),
      }),
    ],
  };
}

/**
 * "limit: Too big: expected number to be <=100". Zod's default texts describe the rule, never the
 * input, so they are safe to show (the same reason as in packages/config).
 */
function describe(issues: Issues): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
