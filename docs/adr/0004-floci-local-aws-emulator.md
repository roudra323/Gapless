# ADR-0004 — Floci as the local AWS emulator for Terraform

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR-0003 (AWS). This ADR adds a local step before it; it doesn't reverse it.

## Context

ADR-0003 puts the cloud on AWS. The EKS control plane is billed per hour, and EKS + RDS take about 25 minutes to create, so learning Terraform by repeated `apply`/`destroy` against real AWS is slow and uses the free credits.

[Floci](https://github.com/floci-io/floci) is an MIT-licensed local AWS emulator (one container, port 4566). Its README lists EKS (a real k3s cluster), RDS (a real Postgres container), ECR (a real registry), Secrets Manager, IAM, STS, S3, ELBv2, and Budgets, and it supports Terraform with the standard `hashicorp/aws` provider. It also states limits: credentials aren't checked unless strict auth is enabled, and some services only store their configuration (for example Application Auto Scaling policies are "stored but inert").

## Decision

Phase 9 has two steps:

- **9a — Floci (local, $0):** write and test `infra/terraform/envs/dev` against Floci until `apply` and `destroy` both succeed. A CI job applies and destroys the same code against Floci on every PR that touches `infra/`.
- **9b — real AWS:** apply the same code to AWS for a short window: the deploy pipeline, the demo, the screenshots. Then destroy it (ADR-0003 cost rules).

Rules:

1. **One codebase.** Only the provider settings (endpoint, credential and account-ID checks) and the backend configuration differ between Floci and AWS. Resources never branch on the target, except where a resource is proven unsupported (rule 3).
2. **Floci state is separate.** Floci runs use their own S3 backend inside Floci (`floci.s3.tfbackend`), never the real state bucket.
3. **Coverage is measured, not assumed.** Phase 9a starts with a short spike: apply the VPC, ECR, RDS, Secrets Manager, and budget resources, then EKS. Record what works in the "Floci coverage" table in `docs/07`. A resource that Floci doesn't support is guarded by one `emulator` variable, and the table says so.
4. **A pass on Floci is not proof for AWS.** These are checked only in 9b: the GitHub OIDC trust, IAM permissions (Floci accepts any credentials by default), the NLB from the AWS Load Balancer Controller, EKS access entries, and Pod Identity.
5. **Pinned like everything else.** Use a Floci release tag pinned by digest, never `latest` or `nightly`. Floci's EKS defaults to `rancher/k3s:latest` and its RDS to `postgres:16-alpine`; override both with pinned images (k3s matching the EKS minor version, Postgres 18) if Floci allows it, and record it in `docs/07` if not.
6. **Floci is local.** `apply` and `destroy` against Floci are not destructive cloud commands (CLAUDE.md rule 10 covers AWS and Azure only).

## Alternatives considered

- **Real AWS only:** the most faithful, but every learning iteration costs EKS hours and about 25 minutes.
- **LocalStack:** the better-known emulator, but EKS, RDS, and ECR have been paid features there. Floci covers them under MIT. (Not re-checked for this ADR.)
- **Validate and plan only (`terraform validate`, `plan` with no apply):** free, but never proves that `apply` and `destroy` succeed.

## Consequences

- Fast, free Terraform iteration, and a CI job that proves the infrastructure applies and destroys cleanly. This is an infrastructure integration test, a strong DevOps signal.
- One more pinned tool to keep current (Renovate tracks the image).
- Floci's EKS is k3s, so cluster add-ons are still developed on kind (Phase 8). Floci's EKS is used only to check that Terraform creates the cluster.
- If the spike shows that Floci covers too little of the stack, Phase 9a shrinks to the resources it does cover, and this ADR is updated.
