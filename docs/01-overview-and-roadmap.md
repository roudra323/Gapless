# 01 — Overview & Roadmap

## Purpose

A portfolio project for junior DevOps and observability roles. It demonstrates, end to end:

- **Kubernetes:** Deployments, Services, Gateway API routing, probes, HPA, PDB, Helm, a migration Job, and a single-writer workload.
- **Cloud (AWS):** EKS, RDS, ECR, Secrets Manager, IAM roles for pods, all provisioned with Terraform (see `adr/0003`).
- **CI/CD:** GitHub Actions with keyless (OIDC) authentication to AWS and Helm-based deploys.
- **Observability:** Prometheus metrics, Grafana dashboards, alert rules routed to a chat channel, structured logs in Loki, runbooks, and a postmortem.
- **Blockchain backend:** a fault-tolerant event indexer (WebSocket drops, RPC errors, reorgs, restarts).

**Scope rule:** the indexer is feature-complete after Phase 4. Later phases add only instrumentation to it (Phase 6), not new logic. Spend the remaining effort on the DevOps and observability phases.

## What it does

1. A Foundry-deployed `MockToken` (ERC-20) lives on **Base Sepolia**, and on **anvil** locally.
2. The **indexer** ingests every `Transfer` event of that token into Postgres. No gaps, no duplicates, and it survives failures.
3. The **API** serves recent transfers, transfers by address, and indexer stats, straight from Postgres (no cache layer).
4. A **load script** generates transfers on demand, so demos always have live traffic.

## Non-goals

- Multi-token or multi-chain indexing. The design shouldn't block it, but don't build it.
- A frontend. Grafana and the API are the UI.
- Auth or user accounts. The API is public and read-only.
- Multi-cloud failover. The cloud is AWS. The optional Phase 11 deploys the same chart to AKS as a separate environment.
- A cache layer (Redis). The API reads Postgres directly; the indexes in `docs/02` keep it fast.

## The demo this project must support

While the load script is producing transfers:

1. `kubectl delete pod -l app.kubernetes.io/component=indexer`, or block the WebSocket.
2. Grafana shows indexer lag spike, the `IndexerLagHigh` alert fires and arrives in the chat channel, then lag recovers. The indexer's log lines for the event are in Grafana (Loki).
3. A verification query proves **zero gaps and zero duplicates** against the chain.
4. A k6 load test pushes the API: the HPA scales the API pods, and the latency panels show it.
5. Push a commit to `main`, and GitHub Actions builds, migrates, and deploys with no API downtime.

Every phase should move toward making this demo work.

## Roadmap

Each phase ends with acceptance criteria. **Don't start phase N+1 until phase N passes.**

**Current status:** **Phase 4 done (2026-11-02).** Next: Phase 5 (API). Update this line when a phase passes.

### Phase 0 — Repo foundation

- Root `package.json` (`packageManager`, `engines`, scripts), `pnpm-workspace.yaml` (workspace and pnpm settings), `tsconfig.base.json`, oxlint, Prettier, Vitest, lefthook, `renovate.json`, Makefile.
- Pin the exact Node 24.x version in `.nvmrc` (it holds only the major in the skeleton).
- CI workflow `ci.yml` with the `quality` and `unit` jobs only (see `docs/08`).
- ✅ Done when a fresh clone passes `pnpm install && pnpm lint && pnpm typecheck && pnpm test`, and CI is green.

### Phase 1 — Contracts & local chain

- `contracts/` Foundry project: `MockToken` (OpenZeppelin ERC-20, mintable by owner), a deploy script, and a `spam-transfers` script.
- `docker-compose.yml`: postgres, anvil.
- ✅ Done when `forge test` passes and the scripts deploy the token and emit N transfers on anvil.

### Phase 2 — Database package

- `packages/db`: Drizzle schema (see `docs/02`), generated SQL migrations, typed client factory, and a migrate entrypoint.
- ✅ Done when migrations apply cleanly to an empty DB and an integration test verifies constraints.

### Phase 3 — Indexer core

- Range processing, checkpointing, idempotent writes, and batch-size adaptation (see `docs/03`).
- HTTP-only at this stage, using polling.
- pino structured logs: the shared logger config in `packages/observability` (see `docs/09` "Logs"), used by the indexer through nestjs-pino and by the migrate entrypoint.
- ✅ Done when an integration test (anvil + testcontainers) indexes 500 transfers with exact parity to the chain, and the indexer logs JSON with the required fields.

### Phase 4 — Indexer resilience

- WebSocket head trigger, retry/backoff, reorg handling, advisory-lock single writer, graceful shutdown, and the indexer health endpoints (`/healthz`, `/readyz`; see `docs/03` "Health").
- ✅ Done when chaos tests pass (see `docs/06`): kill mid-batch, WebSocket drop, reorg on anvil, and two instances. Every one ends with zero gaps and zero duplicates.

### Phase 5 — API

- `/v1/transfers`, `/v1/addresses/:address/transfers`, `/v1/stats`, health endpoints, problem+json errors, and request logging with `reqId` (the pino setup from Phase 3). No cache layer.
- Keep it small: target 1–2 days.
- ✅ Done when e2e tests pass and cursor pagination is stable under concurrent inserts.

### Phase 6 — Observability in code

- prom-client metrics (the exact names in `docs/09`). Structured logs are already in place from Phase 3.
- Indexer instrumentation only, no new logic: `GET /metrics` on the existing `node:http` health server, the `ws_connected` gauge with the WebSocket stall rule (`docs/03` "HeadTracker"), and the metric assertions in the chaos tests that today check log lines (`docs/06`).
- ✅ Done when `/metrics` exposes every documented metric.

### Phase 7 — Containers

- Multi-stage Dockerfiles, non-root, minimal runtime, and base images pinned by digest.
- ✅ Done when the full stack runs via `docker compose --profile app up` and images stay under the size budget in `docs/07`.

### Phase 8 — Local Kubernetes

- kind cluster, Gateway API CRDs + Envoy Gateway, kube-prometheus-stack, a Helm chart for the app, a ServiceMonitor, a PrometheusRule, and a Grafana dashboard.
- Alertmanager routes `warning` and `critical` alerts to one chat webhook (Discord or Slack). The webhook URL is a secret, never committed.
- Logs: **Loki** (storage and query) + **Grafana Alloy** (the collector that ships pod logs to Loki), with Loki as a Grafana data source.
- `docs/runbooks.md`: one short section per alert (meaning, first checks, fix).
- A **k6** load script (`deploy/load/`, `make load`) for the API. Only the API scales (HPA); the indexer stays at 1 replica.
- ✅ Done when `make kind-up && make kind-deploy` gives a working API through the Gateway, live dashboards, the indexer's logs in Grafana, an alert that fires during the kill-pod demo and arrives in the chat channel, and an HPA scale-up under `make load`.

### Phase 9 — AWS + deploy pipeline

Two steps (`adr/0004`): **9a** writes and tests the Terraform against the local Floci emulator ($0), with a CI job that applies and destroys it there on every infra PR. **9b** applies the same code to real AWS for the deploy pipeline and the demo, then destroys it.

- Terraform (`adr/0003`): VPC with public node subnets and private DB subnets (no NAT Gateway), EKS with a Spot managed node group, RDS for PostgreSQL, ECR, the GitHub OIDC provider and deployer role, Secrets Manager, IAM roles for pods (ESO, AWS Load Balancer Controller), and a budget alarm (created first).
- Cluster add-ons via `make eks-bootstrap`: AWS Load Balancer Controller, Envoy Gateway, External Secrets Operator, kube-prometheus-stack, Loki, Alloy.
- The deploy workflow on `main`.
- Remove the GCP `severity` field from the shared logger (`packages/observability`) and its test.
- ✅ 9a done when `make floci-apply` and `make floci-destroy` succeed locally and in CI, and the "Floci coverage" table in `docs/07` is filled in.
- ✅ 9b done when a push to `main` deploys to EKS, migrations run as a Helm hook, the public endpoint serves data, and `make eks-down` removes everything (no NLB or VPC left behind).

### Phase 10 — Polish

- README with an architecture diagram, a demo GIF or video, a "what breaks and how it recovers" section, the cost notes, and a teardown guide.
- `docs/postmortems/`: one postmortem from a real chaos drill (timeline, detection, alert, impact, recovery, follow-ups).
- ✅ Done when someone unfamiliar can understand the project in 2 minutes from the README.

### Phase 11 — AKS port (optional)

- Deploy the same Helm chart to AKS with the Azure for Students credit: its own Terraform root (`infra/terraform/envs/aks/`), Azure Database for PostgreSQL, ACR, and a `values-aks.yaml`. No new app code.
- ✅ Done when the chart serves data on AKS and the environment is torn down again.

### Optional later

OpenTelemetry tracing (after Phase 9 works).
