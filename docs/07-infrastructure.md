# 07 — Infrastructure (Docker, Kubernetes, Helm, Terraform)

## Docker

One Dockerfile per app (`apps/<app>/Dockerfile`), with the build context at the repo root.

- **Multi-stage:**
  1. `deps`: install with a pnpm store cache mount.
  2. `build`: `pnpm --filter @gapless/<app>... build`.
  3. `prod`: `pnpm deploy --filter @gapless/<app> --prod /out`.
  4. `runtime`: copy `/out` only.
- **Runtime image:** distroless Node (matching the Node major) or `node:24-slim`. Base images are **pinned by digest** and updated by Renovate.
- **Non-root:** UID 65532 (distroless `nonroot`) or `node`. The root filesystem must work read-only (write nothing to disk; use `/tmp` via `emptyDir` only if unavoidable).
- `CMD ["node", "dist/main.js"]` in exec form, so Node receives SIGTERM directly. The indexer image also contains `dist/migrate.js` for the migration Job.
- OCI labels: `org.opencontainers.image.source`, `.revision` (Git SHA), `.created`.
- A `.dockerignore` excludes `node_modules`, `.git`, `dist`, `.env*`, `infra`, and `deploy`.
- **Size budget:** each runtime image under 200 MB. Report the size in the PR if it grows.

### docker-compose.yml (local dev)
- Default services: `postgres` (18), `redis` (8), `anvil` (the official Foundry image). All have health checks.
- `--profile app` adds `indexer` and `api` built from the Dockerfiles, for a full-stack smoke test.

## Kubernetes manifests (Helm chart: `deploy/helm/gapless`)

### Resources in the chart
| Resource | Notes |
|---|---|
| `Deployment` api | replicas from values (default 2); rolling update `maxUnavailable: 0`, `maxSurge: 1` |
| `Deployment` indexer | **`replicas: 1`, `strategy: Recreate`** (prevents two pods during rollout); `terminationGracePeriodSeconds: 30` |
| `Service` api | ports `http` 3000 and `metrics` 9464 |
| `Service` indexer | `metrics` 9464 only (for scraping) |
| `HTTPRoute` | `/v1` → api:3000; attaches to the Gateway named in values |
| `HorizontalPodAutoscaler` api | autoscaling/v2, CPU 70%, min 2, max 5 |
| `PodDisruptionBudget` api | `minAvailable: 1` |
| `Job` migrate | Helm hook `pre-install,pre-upgrade`, `hook-delete-policy: before-hook-creation,hook-succeeded`, `backoffLimit: 2`, `ttlSecondsAfterFinished` |
| `ServiceMonitor` ×2 | scrape the `metrics` port every 15s; label matches the kube-prometheus-stack selector |
| `PrometheusRule` | the alerts from `docs/09` |
| `ConfigMap` dashboard | label `grafana_dashboard: "1"`, contents from `deploy/monitoring/dashboards/*.json` |
| `ConfigMap` app-config | non-secret env |
| `ExternalSecret` (GKE only) | maps Secret Manager entries to a K8s Secret |
| `ServiceAccount` ×2 | `automountServiceAccountToken: false` unless needed |
| `NetworkPolicy` | api: ingress from the gateway and Prometheus only; indexer: ingress from Prometheus only |

### Pod standards (every workload)
- `securityContext`: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`. The namespace is labeled for the Pod Security Admission `restricted` profile.
- Resources: set CPU and memory **requests**, and a memory **limit**. Don't set CPU limits (they cause throttling; requests are enough for scheduling).
- Probes: `startupProbe`, `livenessProbe` (`/healthz`), and `readinessProbe` (`/readyz`), all on the metrics port. Semantics are in `docs/02` and `docs/03`.
- Standard labels: `app.kubernetes.io/{name,instance,component,version,part-of,managed-by}`.
- Images are referenced as `repo:gitsha` (values set by CI), never `latest`.

### Values files
- `values.yaml`: defaults, safe and production-like.
- `values-local.yaml`: kind (`imagePullPolicy: Never`, local DB host, plain Secret, Envoy Gateway's Gateway name).
- `values-gke.yaml`: GKE (Artifact Registry repo, ExternalSecret enabled, GKE Gateway class).

## Local cluster (kind): `make kind-up`
1. Create a kind cluster from `deploy/local/kind-config.yaml`, with the node image pinned to the GKE minor version.
2. Install the Gateway API CRDs (standard channel, pinned version) and **Envoy Gateway** (Helm, pinned), then create the `Gateway`.
3. Install **kube-prometheus-stack** (pinned chart version, values in `deploy/monitoring/kps-values.yaml`). Set the ServiceMonitor and Rule selectors to pick up our chart's objects.
4. Deploy local Postgres and Redis from simple manifests in `deploy/local/` (official images, single replica). These are dev-only and never part of the app chart.
5. Create the namespace and the app Secret from your local `.env`.

`make kind-deploy` builds the images, runs `kind load docker-image`, then runs `helm upgrade --install` with `values-local.yaml`.

Also include `make port-forward` for Grafana and the gateway.

## GCP (Terraform: `infra/terraform`)

### Layout
- `bootstrap/`: run once with local state. Creates the GCS state bucket (versioning on) and enables the base APIs.
- `envs/dev/`: everything else. Uses the GCS backend. Variables in `terraform.tfvars` (git-ignored; commit an `.example`).
- Write resources directly rather than pulling in large community modules. The goal is to learn each resource. Split into files by concern: `network.tf`, `gke.tf`, `sql.tf`, `registry.tf`, `iam.tf`, `secrets.tf`, `budget.tf`, `outputs.tf`.

### Resources
| Resource | Spec |
|---|---|
| VPC + subnet | custom mode; secondary ranges for pods and services |
| GKE | **Standard, zonal** (the free tier covers one zonal cluster's management fee), REGULAR channel, Workload Identity enabled, **Gateway API enabled (standard channel)**, Dataplane V2, private nodes + Cloud NAT |
| Node pool | Spot `e2-standard-2`, autoscaling 1–3, auto-repair and auto-upgrade on. Spot preemptions double as free chaos testing. |
| Cloud SQL | Postgres (newest supported major), smallest shared-core tier, Enterprise edition, **private IP** via Private Service Access, automated backups on, deletion protection **off** (it's a learning environment; teardown must work) |
| Artifact Registry | Docker repo, with a cleanup policy keeping the last 20 images |
| Secret Manager | `database-url`, `rpc-http-url`, `rpc-ws-url` (values set manually or via `gcloud`, **never in Terraform state**) |
| External Secrets | GSA with `secretmanager.secretAccessor`, bound to the ESO KSA via Workload Identity |
| GitHub OIDC | Workload Identity Pool + Provider restricted with `attribute_condition` to **this repository** (and `refs/heads/main` for deploy); a deployer GSA with Artifact Registry writer + GKE developer roles |
| Budget | `google_billing_budget` with alerts at 50%, 90%, and 100% of a small monthly amount |
| Region | variable; default `asia-south1` |

Cluster add-ons installed after Terraform via Helm (scripted in `make gke-bootstrap`): External Secrets Operator, kube-prometheus-stack, and the `Gateway` object (`gatewayClassName: gke-l7-global-external-managed`).

### Cost discipline
- `make gke-down` → `terraform destroy` for `envs/dev`. Document how long a full `up` takes.
- Never leave the cluster running when you're not demoing. Keep the README screenshots so the project still shows well while torn down.
