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
- The distroless base image sets `ENTRYPOINT ["/nodejs/bin/node"]`, so the Dockerfile sets only `CMD ["dist/main.js"]`. This is the exec form, so Node is PID 1 and receives SIGTERM directly. The indexer image also contains the `@gapless/db` migrate entrypoint for the migration Job: `node_modules/@gapless/db/dist/bin/migrate.js`, with its `migrations/` folder.
- OCI labels: `org.opencontainers.image.source`, `.revision` (Git SHA), `.created`.
- A `.dockerignore` excludes `node_modules` and `dist` at every depth, `.git`, `.env*`, `infra`, `deploy`, and `contracts`.
- Apps have `"files": ["dist"]` in `package.json`, so `pnpm deploy` copies only the build output (the `packages/*` list their own `files`).
- **Size budget:** each runtime image under 200 MB compressed (the size a registry stores). Measure it with `docker image inspect --format '{{.Size}}' <image>` (the containerd image store reports the compressed size) or `docker save <image> | gzip -c | wc -c`. Report the size in the PR if it grows.

### docker-compose.yml (local dev)

- Default services: `postgres` (18) and `anvil` (the official Foundry image). Both have health checks.
- Host ports are bound to `127.0.0.1` only: postgres `15432` (non-default, so it doesn't clash with a local install), anvil `8545`. `.env.example` uses these ports.
- `--profile app` (Phase 7) adds `migrate`, `indexer` and `api`, built from the Dockerfiles, for a full-stack smoke test: `docker compose --profile app up -d --build --wait`. `migrate` runs once from the indexer image; `indexer` and `api` start only after it exits 0. The app containers use the pod hardening from Kubernetes (read-only root filesystem, all capabilities dropped, `no-new-privileges`) and a `/readyz` health check run by Node (distroless has no shell or curl).
- The app services take only `TOKEN_ADDRESS`, `START_BLOCK`, `CHAIN_ID`, `CONFIRMATIONS`, `LOG_LEVEL` and `GIT_SHA` from `.env` (Compose interpolation, no `env_file`), because `.env` holds host URLs. `TOKEN_ADDRESS` defaults to `0x5FbDB2315678afecb367f032d93F642f64180aa3`, where MockToken lands on a fresh anvil (`contracts/README.md`). The database and RPC URLs use the service names. Host ports: API `3000`, indexer metrics `9464`, API metrics `9465`.

## Kubernetes manifests (Helm chart: `deploy/helm/gapless`)

### Resources in the chart

| Resource                      | Notes                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Deployment` api              | replicas from values (default 2); rolling update `maxUnavailable: 0`, `maxSurge: 1`                                                                                                                                                                                                                                                                                                  |
| `Deployment` indexer          | **`replicas: 1`, `strategy: Recreate`** (prevents two pods during rollout); `terminationGracePeriodSeconds: 30`                                                                                                                                                                                                                                                                      |
| `Service` api                 | ports `http` 3000 and `metrics` 9464                                                                                                                                                                                                                                                                                                                                                 |
| `Service` indexer             | `metrics` 9464 only (for scraping)                                                                                                                                                                                                                                                                                                                                                   |
| `HTTPRoute`                   | `/v1` → api:3000; attaches to the Gateway named in values                                                                                                                                                                                                                                                                                                                            |
| `HorizontalPodAutoscaler` api | autoscaling/v2, CPU 70%, min 2, max 5. When it is on, the Deployment has no `replicas` field (the HPA owns the count); it needs metrics-server                                                                                                                                                                                                                                       |
| `PodDisruptionBudget` api     | `minAvailable: 1`                                                                                                                                                                                                                                                                                                                                                                    |
| `Job` migrate                 | Helm hook `pre-install,pre-upgrade`, `hook-delete-policy: before-hook-creation,hook-succeeded`, `backoffLimit: 2`, `ttlSecondsAfterFinished`. Runs the migrate entrypoint from the indexer image. Its env comes only from the Secret and literal values, because a pre-install hook runs before the ConfigMap exists. A failed Job fails the release and leaves the old Pods running |
| `ServiceMonitor` ×2           | scrape the `metrics` port every 15s. Prometheus selects every ServiceMonitor and PrometheusRule in the cluster (`kps-values.yaml`), so they need no special label                                                                                                                                                                                                                    |
| `PrometheusRule`              | the alerts from `docs/09`, read from the plain rule file `rules/gapless.rules.yaml` in the chart; `make rules-test` runs the promtool unit tests in `deploy/monitoring/tests/`                                                                                                                                                                                                       |
| `ConfigMap` dashboard         | label `grafana_dashboard: "1"`, contents from `dashboards/gapless.json` in the chart (Helm can read only files inside the chart)                                                                                                                                                                                                                                                     |
| `ConfigMap` app-config        | non-secret env                                                                                                                                                                                                                                                                                                                                                                       |
| `ExternalSecret` (EKS only)   | maps Secrets Manager entries to a K8s Secret                                                                                                                                                                                                                                                                                                                                         |
| `ServiceAccount` ×2           | `automountServiceAccountToken: false` unless needed                                                                                                                                                                                                                                                                                                                                  |
| `NetworkPolicy`               | api: ingress from the gateway and Prometheus only; indexer: ingress from Prometheus only. The gateway = Pods with `gateway.networking.k8s.io/gateway-name` in the Gateway's namespace; Prometheus = Pods `app.kubernetes.io/name: prometheus` in the `monitoring` namespace. kindnet (kind) enforces it                                                                              |

### Pod standards (every workload)

- `securityContext`: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`. The namespace is labeled for the Pod Security Admission `restricted` profile.
- Resources: set CPU and memory **requests**, and a memory **limit**. Don't set CPU limits (they cause throttling; requests are enough for scheduling).
- Probes: `startupProbe`, `livenessProbe` (`/healthz`), and `readinessProbe` (`/readyz`), all on the metrics port. Semantics are in `docs/02` and `docs/03`.
- Standard labels: `app.kubernetes.io/{name,instance,component,version,part-of,managed-by}`.
- Images are referenced as `repo:gitsha` (values set by CI), never `latest`. The chart fails to render without `image.tag` or with `latest`, and sets `APP_VERSION` from the same tag.

### Values files

- `values.yaml`: defaults, safe and production-like.
- `values-local.yaml`: kind (`imagePullPolicy: Never`, the anvil chain ID and token address, Envoy Gateway's Gateway name). The chart never creates the app Secret: `make kind-up` creates it on kind.
- `values-eks.yaml`: EKS (ECR repo, ExternalSecret enabled, the Envoy Gateway's Gateway name).

## Local cluster (kind): `make kind-up`

1. Create a kind cluster from `deploy/local/kind-config.yaml`, with the node image pinned to the EKS minor version.
2. Install the Gateway API CRDs (standard channel, the version pinned by the Envoy Gateway CRD chart `gateway-crds-helm`, applied server-side) and **Envoy Gateway** (Helm, pinned, `crds.enabled=false`), then apply `deploy/local/gateway.yaml`: the `Gateway` `gapless-gateway` in `envoy-gateway-system`, which accepts routes only from the `gapless` namespace. Its `EnvoyProxy` makes the proxy a NodePort Service on `30080`, and `kind-config.yaml` maps that to `http://localhost:8080` on the Mac (kind has no cloud load balancer).
3. Install **kube-prometheus-stack** in the `monitoring` namespace (pinned chart version, values in `deploy/monitoring/kps-values.yaml`). Set the ServiceMonitor, PodMonitor, Probe and Rule selectors to select every object (`*SelectorNilUsesHelmValues: false`): the default selects only objects with the release's label, and a missing label fails silently. `kind-up` also waits for the Prometheus and Alertmanager StatefulSets, which the Operator creates after Helm returns. kind's etcd, scheduler, controller manager and kube-proxy are not scraped (their metrics listen on 127.0.0.1). Grafana generates a random admin password into the Secret `kube-prometheus-stack-grafana` (`kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d`). Before the install, `kind-up` creates the Secret `alertmanager-discord` (key `url`) in `monitoring` from the file `~/.config/gapless/discord-webhook-url` (outside the repo, mode 600; override the path with `DISCORD_WEBHOOK_FILE=…`). Alertmanager mounts it (`alertmanagerSpec.secrets`) and reads it with `webhook_url_file`, so the URL never enters the repo, the values or the Helm release. Without the file, `kind-up` prints a warning and uses a dummy URL: alerts still fire in the UI but reach no chat. When the Mac sleeps, the kind node pauses too, and after the wake every rule group reports the missed evaluations at once: `PrometheusMissingRuleEvaluations` can go pending for a short time. That is expected on a laptop and is not a Prometheus fault, so the rule stays on. Routing: `docs/09` "Alerts".
4. Install **Loki** (single-binary mode, `emptyDir` storage) and **Grafana Alloy** (pinned charts, values in `deploy/monitoring/`), and add Loki as a Grafana data source.
5. Create the `gapless` namespace (`deploy/local/namespace.yaml`, labeled for the Pod Security Admission `restricted` profile), then deploy the dev-only Postgres and anvil from `deploy/local/postgres.yaml` and `deploy/local/anvil.yaml` (the same pinned images as `docker-compose.yml`, one replica each, run as non-root to pass `restricted`). They are never part of the app chart. Postgres keeps its data on a PersistentVolumeClaim; anvil keeps its chain in memory, so a new anvil Pod is a new, empty chain. anvil is also a NodePort on `30545`, mapped to `http://localhost:18545` on the Mac for the MockToken deploy.
6. Create the app Secret `gapless-secrets` (`DATABASE_URL`, `RPC_HTTP_URL`, `RPC_WS_URL`) with the in-cluster dev values (the same credentials as `docker-compose.yml`, so nothing secret). On EKS, the External Secrets Operator fills the same Secret from Secrets Manager.

`make chart-lint` runs `helm lint --strict` and checks the rendered chart with `kubeconform -strict` against the Kubernetes version of `kind-config.yaml` and the CRD schemas (HTTPRoute, ServiceMonitor) from the `datreeio/CRDs-catalog` repository, pinned to a commit in the `Makefile`.

`make kind-deploy` builds both images, runs `kind load docker-image`, then runs `helm upgrade --install` with `values-local.yaml` and `--wait`. The image tag is the short git SHA. Uncommitted changes add `-dirty-<hash of the diff>`, so each changed working tree gets a new tag and a new rollout (untracked files are not in the hash; `IMAGE_TAG=…` overrides the tag). Deploy the MockToken to `http://localhost:18545` before the first `kind-deploy`: without contract code at `TOKEN_ADDRESS`, the indexer exits at startup and `--wait` times out.

**Alert demo (kill the indexer):** `kubectl --context kind-gapless -n gapless scale deploy/gapless-indexer --replicas 0`. After about 2.5 minutes (the 2m `for:` plus the scrape and evaluation intervals), `IndexerNoLeader` (critical) fires, and Alertmanager posts it to Discord after its 30s `group_wait`. `kubectl --context kind-gapless -n gapless scale deploy/gapless-indexer --replicas 1` brings the indexer back; the "resolved" message follows within the 5m `group_interval`. The indexer resumes from its checkpoint, so no blocks are lost.

Also include `make port-forward` for Grafana and the gateway, and `make load`, which runs the k6 script in `deploy/load/` (the pinned `grafana/k6` image) against the gateway.

## AWS (Terraform: `infra/terraform`)

Decisions and trade-offs: `adr/0003` (AWS) and `adr/0004` (Floci).

### Layout

- `bootstrap/`: run once with local state. Creates the S3 state bucket (versioning on, public access blocked, encryption on).
- `envs/dev/`: everything else. Uses the S3 backend with `use_lockfile = true`. Variables in `terraform.tfvars` (git-ignored; commit an `.example`).
- `envs/aks/` (optional Phase 11): its own root and state for the AKS port.
- Write resources directly rather than pulling in large community modules. The goal is to learn each resource. Split into files by concern: `network.tf`, `eks.tf`, `rds.tf`, `ecr.tf`, `iam.tf`, `secrets.tf`, `budget.tf`, `outputs.tf`.

### Resources

| Resource        | Spec                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget          | `aws_budgets_budget` with alerts at 50%, 90%, and 100% of a small monthly amount. **Create it first.**                                                                                                                                               |
| VPC             | 2 AZs. **Public subnets** for the nodes (public IPs, internet gateway) and **private subnets** for RDS. **No NAT Gateway** and no interface endpoints (cost; see `adr/0003`).                                                                        |
| Security groups | Nodes: no inbound from the internet except from the NLB to the Envoy proxy ports. RDS: inbound 5432 from the node security group only.                                                                                                               |
| EKS             | Standard mode (not Auto Mode), a Kubernetes version in standard support, **access entries** for cluster access (not the `aws-auth` ConfigMap), the VPC CNI with network policy enabled, and the EKS Pod Identity agent add-on.                       |
| Node group      | Managed, **Spot**, 2 instance types for Spot availability (for example `t3.medium` and `t3a.medium`), scaling 1–3. Spot interruptions double as free chaos testing.                                                                                  |
| RDS             | PostgreSQL (newest supported major), smallest burstable class, single-AZ, private subnets, no public access, automated backups on (short retention), deletion protection **off** and no final snapshot (a learning environment; teardown must work). |
| ECR             | One repository per app, with a lifecycle policy keeping the last 20 images.                                                                                                                                                                          |
| Secrets Manager | `gapless/database-url`, `gapless/rpc-http-url`, `gapless/rpc-ws-url`. Terraform creates the secrets only; values are set with `aws secretsmanager put-secret-value`, **never in Terraform state**.                                                   |
| IAM for pods    | A role for External Secrets (read the three secrets only) and a role for the AWS Load Balancer Controller, bound with EKS Pod Identity (or IRSA where an add-on doesn't support it).                                                                 |
| GitHub OIDC     | `aws_iam_openid_connect_provider` for GitHub, and a deployer role whose trust policy allows only **this repository** on `refs/heads/main`; permissions: push to the two ECR repos, and an EKS access entry scoped to the `gapless` namespace.        |
| Region          | variable; default `ap-south-1`                                                                                                                                                                                                                       |

Cluster add-ons installed after Terraform via Helm (scripted in `make eks-bootstrap`): AWS Load Balancer Controller, Gateway API CRDs + **Envoy Gateway** and the `Gateway` (its proxy Service is annotated for an internet-facing NLB), External Secrets Operator, kube-prometheus-stack, Loki, and Alloy. Prometheus and Loki use `emptyDir` storage on EKS too, so no EBS CSI driver is needed; their data is lost when a node is replaced, which is accepted for a learning environment.

### Local runs against Floci (Phase 9a)

- `make floci-up` starts the pinned Floci container on `localhost:4566` (with the Docker socket mounted, because Floci starts real containers for EKS and RDS). `make floci-apply` runs `terraform init -reconfigure -backend-config=floci.s3.tfbackend` and `terraform apply` for `envs/dev` against it; `make floci-destroy` destroys it again; `make floci-down` stops the container.
- `envs/dev/floci.s3.tfbackend` (committed, no secrets) points the S3 backend at a state bucket inside Floci, never at the real state bucket. Dummy credentials only.
- The provider block switches only its endpoint and its credential and account-ID checks (`var.emulator`). Resources don't branch on the target, except where the coverage table below says a resource is unsupported.
- Pin the k3s image used for Floci's EKS to the EKS minor version and the RDS image to Postgres 18, if Floci allows the override. Record it below if it doesn't.

#### Floci coverage

Fill this in during the Phase 9a spike (`adr/0004` rule 3). "Checked only on AWS" means a pass on Floci proves nothing about it.

| Resource                            | Works on Floci? | Notes                                              |
| ----------------------------------- | --------------- | -------------------------------------------------- |
| VPC, subnets, SGs, internet gateway | to check        |                                                    |
| ECR                                 | to check        |                                                    |
| RDS                                 | to check        |                                                    |
| Secrets Manager                     | to check        |                                                    |
| Budget                              | to check        |                                                    |
| EKS + node group                    | to check        |                                                    |
| EKS access entries, Pod Identity    | to check        | Checked only on AWS (IAM is not enforced on Floci) |
| GitHub OIDC provider + role         | to check        | The trust from GitHub is checked only on AWS       |
| NLB from the LB Controller          | n/a             | Not in Terraform; checked only on AWS              |

### Cost discipline

- The EKS control plane is billed per hour while the cluster exists. Creating EKS and RDS takes about 25 minutes, so destroy the environment at the end of each **work period** (a few days), not after every session.
- `make eks-down` first uninstalls the Envoy Gateway release (so the controller deletes the NLB, which isn't in Terraform state), then runs `terraform destroy` for `envs/dev`. Document how long a full `up` takes.
- Never leave the cluster running when you're not working or demoing. Keep the README screenshots so the project still shows well while torn down.
