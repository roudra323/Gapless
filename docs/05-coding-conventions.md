# 05 — Coding Conventions

These are rules. If one blocks you, raise it. Don't work around it.

## TypeScript

- `tsconfig.base.json` at the root, extended by every package:
  - `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`
  - `module` and `moduleResolution`: `NodeNext`, `target`: `ES2024` or newer
  - `experimentalDecorators: true`, `emitDecoratorMetadata: true` (**apps only**, since NestJS DI needs them)
  - `isolatedModules: true`, `skipLibCheck: true`, `declaration: true` in packages
  - Nothing deprecated in TS 6.0 (no `baseUrl`-only path hacks, no `moduleResolution: node`/`node10`, no `outFile`, no `target: ES5`).
- **ESM imports:** relative imports include the `.js` extension (`import { x } from './x.js'`). Workspace packages are imported by name (`@gapless/db`) through their `exports` map.
- **No `any`.** Use `unknown` and narrow. `catch (err)` is `unknown`, so narrow before use.
- **Don't `import type` a class that Nest injects through the constructor.** Decorator metadata needs the runtime value. Use `import type` for everything else that's type-only.
- Prefer `type` aliases for data shapes and `interface` only for contracts meant to be implemented. Don't use `enum`; use `as const` objects with union types.
- `readonly` on properties and arrays that aren't mutated.
- Explicit return types on exported functions and public methods.
- Prefer named exports, never default exports (Nest modules included).

## Blockchain values

- **Block numbers, log indexes from viem, and token amounts stay `bigint`** inside the app. Never convert a token amount to `Number` or float. Convert at boundaries only: DB `numeric` ↔ `bigint` in the repository layer, and `bigint` → decimal `string` in API serialization.
- **Addresses:** validate with viem `isAddress`. Store **lowercase**. Return **checksummed** via `getAddress`. One helper pair in `packages/chain` (`normalizeAddress`, `toChecksum`), used everywhere.
- Hashes are stored lowercase `0x`-prefixed.
- ABIs are typed `as const` (viem `parseAbi` or a JSON ABI with `as const`) so event args are fully typed.

## Naming

| Thing                 | Style                          | Example                                                                |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| Files                 | kebab-case + role suffix       | `transfers.controller.ts`, `range-planner.ts`, `range-planner.spec.ts` |
| Classes, types        | PascalCase                     | `TransferRepository`, `TransferRow`                                    |
| Functions, variables  | camelCase                      | `planNextRange`                                                        |
| Constants             | UPPER_SNAKE                    | `MAX_PAGE_SIZE`                                                        |
| Env vars              | UPPER_SNAKE                    | `RPC_HTTP_URL`                                                         |
| DB tables and columns | snake_case, plural tables      | `transfers.block_number`                                               |
| Metrics               | `gapless_<area>_<name>_<unit>` | `gapless_indexer_batch_duration_seconds`                               |
| Error codes           | UPPER_SNAKE                    | `INVALID_CURSOR`                                                       |
| Workspace packages    | `@gapless/<name>`              | `@gapless/db`                                                          |

## NestJS structure

- **One feature = one folder** containing its module, controller, service, repository, schemas, and specs.
- **Layering (strict):** controller → service → repository → Drizzle.
  - Controllers handle HTTP only: parse/validate input, call the service, map to the response DTO. No business logic, no DB.
  - Services hold the business logic. They don't know about HTTP (no `Request`, no `HttpException`). They throw **domain errors**.
  - Repositories are the only place Drizzle is used. They return domain types, not raw rows.
- **Validation:** Zod schemas next to the feature (`transfers.schemas.ts`), passed via Nest 12's Standard Schema support on `@Query({ schema })` / `@Param({ schema })`. Infer TS types from schemas (`z.infer`) and don't duplicate them by hand.
- **Response DTOs** are plain functions (`toTransferResponse(row)`) that are explicit about the output shape. Never return DB rows directly.
- Providers are injected via the constructor. No service locators, no `ModuleRef.get` in business code.
- Global setup in `main.ts`: `enableShutdownHooks()`, the problem+json exception filter, and the pino logger.

## Errors

- Domain errors extend one base: `class DomainError extends Error { constructor(readonly code: ErrorCode, message: string, readonly cause?: unknown) }`.
- The global exception filter maps domain errors to RFC 9457 problem+json with an `errorCode`. Unknown errors become 500 with a generic body. Log the full error server-side and never leak stack traces or SQL.
- Never swallow errors. A `catch` must either handle the error meaningfully (retry, fallback, translate) or rethrow with `cause`.
- Redis failures in the API are **non-fatal**: log a `warn`, increment the cache-error metric, and fall through to the DB.

## Configuration

- `process.env` is read in **exactly one place**: `packages/config`. Everything else receives a typed config object through DI.
- Each app has its own Zod schema. Parse at boot, and on failure print which keys are invalid (never the values) and exit 1.
- Secrets (`DATABASE_URL`, `RPC_*`) are marked so the logger redacts them.

## Logging

- Use the injected pino logger. **No `console.*`** (lint-enforced).
- Structured fields, not string interpolation: `logger.info({ fromBlock, toBlock, count }, 'batch indexed')`.
- Required context fields in the indexer: `chainId`, `fromBlock`, `toBlock` (where relevant).
- Levels: `fatal` (process exiting), `error` (a failed operation needing attention), `warn` (recovered or degraded: reorg, retry exhausted for one attempt, cache down), `info` (lifecycle and batch summaries), `debug` (per-request detail, off in production).
- Don't log per-event lines at `info`. Log one summary line per batch.

## Async and concurrency

- No floating promises. Every promise is awaited, returned, or explicitly `void`-ed with a comment explaining why.
- Use `AbortSignal` for cancellable waits and shutdown. Timers are cleared on shutdown.
- No unbounded parallelism. Use explicit concurrency limits for fan-out RPC calls; JSON-RPC batching via the viem HTTP transport `batch` option is preferred.

## Database

- All writes that must be consistent go in `db.transaction(...)`.
- Write idempotent inserts (`onConflictDoNothing`) for chain data.
- Every query that runs on a request path must hit an index. When adding a query, add the index in the same migration.
- Keep raw SQL to the minimum (advisory locks, things Drizzle can't express), and use Drizzle's `sql` template with parameters. Never string-concatenate SQL.

## Dependencies

- Check `docs/04` first. Use exact versions. Workspace packages use `workspace:*`.
- Each package's `package.json` has an `exports` map, `"type": "module"`, and `engines.node`.

## Git

- **Conventional Commits:** `feat|fix|refactor|perf|test|docs|build|ci|chore(scope): summary`. Scopes: `indexer`, `api`, `db`, `chain`, `config`, `obs`, `contracts`, `helm`, `infra`, `ci`, `docs`.
- Branches: `feat/<short-name>`, `fix/<short-name>`.
- Small PRs: one concern each. Infrastructure changes and app changes go in separate PRs where possible.
- Never commit generated build output, `.env`, `*.tfstate`, or kubeconfigs. Keep `.gitignore` complete.

## Comments and docs

- Comments explain **why**, not what. Link the doc section for non-obvious invariants (`// see docs/03 "Atomic progress"`).
- TSDoc on exported functions in `packages/*`.
- `TODO` comments must reference an issue or a roadmap phase: `// TODO(phase-6): ...`.
