# 08 — CI/CD (GitHub Actions)

## Global rules for every workflow

- **Pin every action to a full commit SHA**, with the version in a trailing comment: `uses: actions/checkout@<sha> # v5.x.x`. Renovate updates them.
- Least privilege: top-level `permissions: {}` (or `contents: read`), and grant more per job only where needed (`id-token: write` only on jobs that authenticate to GCP).
- `concurrency` groups: cancel superseded PR runs; **never** cancel an in-progress deploy (`cancel-in-progress: false` for deploy).
- No secrets in logs. No long-lived GCP keys. GCP auth is only via `google-github-actions/auth` with Workload Identity Federation.
- Node version comes from `.nvmrc`; pnpm comes from the `packageManager` field. Cache the pnpm store.
- Use path filters, so infra jobs run only when `infra/**` changes and contract jobs only when `contracts/**` changes.

## Workflows

### `ci.yml`: on `pull_request` and `push` to `main`

| Job           | Steps                                                                                                                                                                          | Added in phase |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `quality`     | install (`--frozen-lockfile`) → `pnpm lint` → `pnpm format:check` → `pnpm typecheck`                                                                                           | 0              |
| `unit`        | `pnpm test`                                                                                                                                                                    | 0              |
| `contracts`   | Foundry toolchain → `forge fmt --check` → `forge build` → `forge test`                                                                                                         | 1              |
| `integration` | `pnpm test:integration` (Testcontainers uses the runner's Docker; install Foundry for anvil)                                                                                   | 2              |
| `images`      | `docker buildx build` both apps (no push), with the GitHub Actions cache backend; fail if the image exceeds the size budget                                                    | 7              |
| `manifests`   | `helm lint` + `helm template` for each values file, piped to `kubeconform -strict` (with the CRD schema catalog for HTTPRoute, ServiceMonitor, PrometheusRule, ExternalSecret) | 8              |
| `terraform`   | `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`, `tflint`                                                                             | 9              |

Add each job in the phase that brings its tool, not before. Branch protection on `main` requires every job that exists to pass. `deploy.yml` and `infra.yml` are added in phase 9.

### `deploy.yml`: on `push` to `main` (after CI succeeds) and `workflow_dispatch`

Uses a GitHub **Environment** `dev` (it holds non-secret vars: project ID, region, cluster name, WIF provider, deployer SA, registry path).

1. Authenticate to GCP via WIF (`id-token: write`).
2. Build and push both images to Artifact Registry, tagged with the **Git SHA**. Also push a provenance attestation (`docker/build-push-action` with `provenance: true`).
3. `get-gke-credentials`.
4. `helm upgrade --install gapless deploy/helm/gapless -f values.yaml -f values-gke.yaml --set image.tag=$GITHUB_SHA --wait --timeout 10m` plus the rollback-on-failure flag. (Helm 4 renamed `--atomic` to `--rollback-on-failure`; confirm with `helm upgrade --help` for the installed version.)
   - The migration Job runs as a pre-upgrade hook. If it fails, the release fails and the old pods keep serving.
5. Smoke test: `curl` the public `/v1/stats` endpoint through the Gateway and assert HTTP 200 and `lagBlocks` present.
6. Write the deployed SHA and image digests to the job summary.

### `infra.yml`: Terraform for `infra/terraform/envs/dev`

- On PRs touching `infra/**`: `terraform plan`, with the plan posted as a PR comment.
- Apply **only** via `workflow_dispatch` with a required-reviewer protection rule on the `infra` environment. Never auto-apply on merge.

### `renovate`

Use the hosted Renovate GitHub App (preferred) or a scheduled workflow. Config in `renovate.json`:

- `extends: ["config:recommended", "helpers:pinGitHubActionDigests", "docker:pinDigests"]`
- `minimumReleaseAge: "3 days"`
- Group non-major npm updates weekly. Majors come as individual PRs; never auto-merge majors.
- Also manage Dockerfiles, Helm chart versions in the Makefile/values, the Terraform providers, and `.nvmrc`.

## Release and versioning

- Every merge to `main` is deployable. The image tag is the Git SHA.
- The chart `version` is bumped when templates change; `appVersion` is set to the SHA at deploy time.
- Rollback: `helm rollback gapless <revision>`. Document it in the README. Migrations are additive-first (see `docs/02`), so rolling back app code is safe.
