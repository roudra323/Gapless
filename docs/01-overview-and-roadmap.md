# 01 — Overview & Roadmap

## Purpose

A portfolio project that demonstrates, end to end:

- **Kubernetes:** Deployments, Services, Gateway API routing, probes, HPA, PDB, Helm, a migration Job, and a single-writer workload.
- **Cloud (GCP):** GKE, Cloud SQL, Artifact Registry, Secret Manager, Workload Identity, all provisioned with Terraform.
- **CI/CD:** GitHub Actions with keyless (OIDC) authentication to GCP and Helm-based deploys.
- **Observability:** Prometheus metrics, Grafana dashboards, alert rules, structured logs.
- **Blockchain backend:** a fault-tolerant event indexer (WebSocket drops, RPC errors, reorgs, restarts).

## What it does

1. A Foundry-deployed `MockToken` (ERC-20) lives on **Base Sepolia**, and on **anvil** locally.
2. The **indexer** ingests every `Transfer` event of that token into Postgres. No gaps, no duplicates, and it survives failures.
3. The **API** serves recent transfers, transfers by address, and indexer stats, with Redis caching.
4. A **load script** generates transfers on demand, so demos always have live traffic.

## Non-goals

- Multi-token or multi-chain indexing. The design shouldn't block it, but don't build it.
- A frontend. Grafana and the API are the UI.
- Auth or user accounts. The API is public and read-only.
- Multi-cloud. The cloud is GCP only.

## The demo this project must support

While the load script is producing transfers:

1. `kubectl delete pod -l app.kubernetes.io/component=indexer`, or block the WebSocket.
2. Grafana shows indexer lag spike, the `IndexerLagHigh` alert fires, then lag recovers.
3. A verification query proves **zero gaps and zero duplicates** against the chain.
4. Push a commit to `main`, and GitHub Actions builds, migrates, and deploys with no API downtime.

Every phase should move toward making this demo work.

## Roadmap

Each phase ends with acceptance criteria. **Don't start phase N+1 until phase N passes.**

**Current status:** **Phase 2 done (2026-10-28).** Next: Phase 3 (indexer core). Update this line when a phase passes.

### Phase 0 — Repo foundation

- Root `package.json` (`packageManager`, `engines`, scripts), `pnpm-workspace.yaml` (workspace and pnpm settings), `tsconfig.base.json`, oxlint, Prettier, Vitest, lefthook, `renovate.json`, Makefile.
- Pin the exact Node 24.x version in `.nvmrc` (it holds only the major in the skeleton).
- CI workflow `ci.yml` with the `quality` and `unit` jobs only (see `docs/08`).
- ✅ Done when a fresh clone passes `pnpm install && pnpm lint && pnpm typecheck && pnpm test`, and CI is green.

### Phase 1 — Contracts & local chain

- `contracts/` Foundry project: `MockToken` (OpenZeppelin ERC-20, mintable by owner), a deploy script, and a `spam-transfers` script.
- `docker-compose.yml`: postgres, redis, anvil.
- ✅ Done when `forge test` passes and the scripts deploy the token and emit N transfers on anvil.

### Phase 2 — Database package

- `packages/db`: Drizzle schema (see `docs/02`), generated SQL migrations, typed client factory, and a migrate entrypoint.
- ✅ Done when migrations apply cleanly to an empty DB and an integration test verifies constraints.

### Phase 3 — Indexer core

- Range processing, checkpointing, idempotent writes, and batch-size adaptation (see `docs/03`).
- HTTP-only at this stage, using polling.
- ✅ Done when an integration test (anvil + testcontainers) indexes 500 transfers with exact parity to the chain.

### Phase 4 — Indexer resilience

- WebSocket head trigger, retry/backoff, reorg handling, advisory-lock single writer, graceful shutdown.
- ✅ Done when chaos tests pass (see `docs/06`): kill mid-batch, WebSocket drop, reorg on anvil, and two instances. Every one ends with zero gaps and zero duplicates.

### Phase 5 — API

- `/v1/transfers`, `/v1/addresses/:address/transfers`, `/v1/stats`, health endpoints, cache-aside with Redis, problem+json errors.
- ✅ Done when e2e tests pass and cursor pagination is stable under concurrent inserts.

### Phase 6 — Observability in code

- prom-client metrics (the exact names in `docs/09`) and pino structured logs.
- ✅ Done when `/metrics` exposes every documented metric and logs are JSON with the required fields.

### Phase 7 — Containers

- Multi-stage Dockerfiles, non-root, minimal runtime, and base images pinned by digest.
- ✅ Done when the full stack runs via `docker compose --profile app up` and images stay under the size budget in `docs/07`.

### Phase 8 — Local Kubernetes

- kind cluster, Gateway API CRDs + Envoy Gateway, kube-prometheus-stack, a Helm chart for the app, a ServiceMonitor, a PrometheusRule, and a Grafana dashboard.
- ✅ Done when `make kind-up && make kind-deploy` gives a working API through the Gateway, live dashboards, and an alert that fires during the kill-pod demo.

### Phase 9 — GCP + deploy pipeline

- Terraform: VPC, GKE Standard, Cloud SQL, Artifact Registry, Workload Identity Federation for GitHub, Secret Manager, External Secrets, and a budget alert.
- The deploy workflow on `main`.
- ✅ Done when a push to `main` deploys to GKE, migrations run as a Helm hook, and the public endpoint serves data.

### Phase 10 — Polish

- README with an architecture diagram, a demo GIF or video, a "what breaks and how it recovers" section, the cost notes, and a teardown guide.
- ✅ Done when someone unfamiliar can understand the project in 2 minutes from the README.

### Optional later

OpenTelemetry tracing, Loki for logs, Argo CD (GitOps) instead of push-based Helm deploys, and a k6 load test.
