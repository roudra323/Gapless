# CLAUDE.md — Gapless

Gapless is a **resilient ERC-20 Transfer indexer + read API**, deployed on **Kubernetes (GKE)** with **Terraform**, **GitHub Actions CI/CD**, and **Prometheus/Grafana** observability.

The app is deliberately small. The engineering quality is the point: correctness under failure, clean infrastructure, real observability. Treat every change as if it were going to production.

**Status:** skeleton only. The folder tree and docs exist; no code or tool config yet. Current phase: see `docs/01-overview-and-roadmap.md`.

## Read before working

| When you are…                            | Read                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| Starting any task                        | `docs/01-overview-and-roadmap.md` (find the current phase) |
| Touching structure or data flow          | `docs/02-architecture.md`                                  |
| Touching the indexer                     | `docs/03-indexer-design.md` (**mandatory**)                |
| Adding or upgrading a dependency or tool | `docs/04-tech-stack-and-versions.md`                       |
| Writing any code                         | `docs/05-coding-conventions.md`                            |
| Writing tests                            | `docs/06-testing.md`                                       |
| Docker, Helm, Kubernetes, Terraform      | `docs/07-infrastructure.md`                                |
| GitHub Actions                           | `docs/08-ci-cd.md`                                         |
| Metrics, logs, dashboards, alerts        | `docs/09-observability.md`                                 |
| Changing a recorded decision             | `docs/adr/`                                                |

## Non-negotiable rules

1. **Work phase by phase.** Follow the roadmap in `docs/01`. Finish a phase's acceptance criteria before starting the next. The skeleton folders already exist; don't add code or config for a future phase early. When a phase is done, update the "Current status" line in `docs/01`.
2. **Never use deprecated, retired, or legacy tools.** The banned list is in `docs/04`. Before installing anything, check the current stable version with `pnpm view <pkg> version` (or the official release page) and pin it. Never install something you only "remember" without checking.
3. **No new dependency without justification.** Prefer the platform (Node built-ins, `fetch`, viem utilities) and add packages only when needed. Record notable additions in `docs/04`.
4. **Conventions in `docs/05` are rules, not suggestions.** If a rule blocks you, stop and say so. Don't silently deviate.
5. **Decisions live in ADRs.** Don't reverse a decision in `docs/adr/` without a new ADR that supersedes it, and ask the user first.
6. **Docs stay true.** If you change behavior covered by a doc (env vars, metrics, endpoints, schema, commands), update that doc in the same change.
7. **Indexer correctness invariants (from `docs/03`) must never be broken:** no gaps, no duplicates, checkpoint advances only in the same DB transaction as the data, a single active writer.
8. **Secrets never enter the repo**, including `.env` files with real values, RPC URLs with API keys, and service-account keys. Commit `.env.example` only.
9. **Tests accompany code.** A feature without tests is not done (see `docs/06`).
10. **Don't run destructive cloud commands** (`terraform apply` or `destroy` against GCP, `helm uninstall` on GKE) unless the user explicitly asks in that message.
11. **Chat in ASD-STE100.** Write all replies to the user in ASD-STE100 Simplified Technical English. Repo docs and code comments use normal technical English.

## Commands (target — keep this section accurate)

None of these exist yet. Each one is added in the phase shown. When you add one, make it work exactly as described here, or update this list.

```bash
# Phase 0
pnpm install                 # install workspace deps
pnpm lint                    # oxlint
pnpm format:check            # prettier --check
pnpm typecheck               # tsc --noEmit across workspace
pnpm test                    # unit tests (vitest)
pnpm -r build                # build all packages (topological order)
# Phase 1
pnpm dev:deps                # docker compose up: postgres, redis, anvil
# Phase 2
pnpm db:generate             # drizzle-kit generate (SQL migration files)
pnpm db:migrate              # apply migrations to DATABASE_URL
pnpm test:integration        # testcontainers + anvil
# Phase 3
pnpm verify                  # compare DB vs getLogs for a block range (gaps/duplicates)
# Phase 8
make kind-up                 # local cluster + gateway + monitoring stack
make kind-deploy             # build images, kind load, helm upgrade (local values)
make kind-down
make port-forward            # Grafana and the gateway
# Phase 9
make gke-bootstrap           # cluster add-ons via Helm (ESO, kube-prometheus-stack, Gateway)
make gke-down                # terraform destroy for envs/dev (only when the user asks)
```

## Definition of done (every change)

Each check applies once its tool exists in the repo.

- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` passes
- [ ] Integration tests pass if the indexer, DB, or API changed
- [ ] `forge test` passes if `contracts/` changed
- [ ] `helm lint` and `kubeconform` pass if `deploy/` changed
- [ ] `terraform fmt -check && terraform validate` pass if `infra/` changed
- [ ] Docs updated (env vars, metrics, endpoints, commands)
- [ ] Conventional Commit message (`feat(indexer): ...`)
