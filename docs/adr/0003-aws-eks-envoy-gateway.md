# ADR-0003 — AWS (EKS + RDS) with Envoy Gateway; optional AKS port

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** ADR-0002

## Context

The project exists to qualify for junior DevOps and observability roles. The target job descriptions name **AWS** (and often Azure) for cloud deploys, GitHub Actions for CI/CD, and monitoring tooling. ADR-0002 chose GKE for its free management-fee credit, but GCP matches fewer of those job descriptions.

Budget: AWS Free Tier credits for a new account, and a $100 Azure for Students credit. The EKS control plane has no free tier (an hourly fee while the cluster exists), so cost control comes from tearing the environment down between work periods.

ADR-0002 also chose the GKE Gateway controller for the cloud, which doesn't exist on EKS. The cloud needs its own Gateway API implementation.

## Decision

- **Cloud: AWS.** EKS (standard mode, not Auto Mode), a managed node group of Spot instances, RDS for PostgreSQL, ECR, Secrets Manager with External Secrets Operator, IAM roles for pods, and a GitHub OIDC IAM role for CI. All provisioned with Terraform.
- **Networking without a NAT Gateway:** worker nodes run in **public subnets with public IPs**, locked down by security groups (no inbound from the internet except through the load balancer). RDS runs in **private subnets** with no public access; only the node security group may reach it. This avoids the hourly NAT Gateway cost and the cost of VPC interface endpoints (ECR, STS, Secrets Manager).
- **Ingress: Envoy Gateway on both kind and EKS.** One Gateway API implementation to learn and debug. On EKS, the **AWS Load Balancer Controller** provisions an NLB in front of the Envoy proxy Service. No `Ingress` resources.
- **Teardown per work period:** EKS and RDS take about 25 minutes to create, so the environment is destroyed at the end of each work period of a few days, not after every session. A budget alarm is created before any other resource.
- **Azure: an optional port after Phase 10.** Deploy the same Helm chart to AKS with the student credit, using its own Terraform root and a `values-aks.yaml`. No multi-cloud failover.

## Alternatives considered

- **Keep GKE (ADR-0002):** the cheapest option (the management fee is covered), but GCP matches fewer target job descriptions.
- **NAT Gateway + private nodes:** the production pattern, but it costs money every hour the environment exists. Recorded as the production upgrade path.
- **AWS Load Balancer Controller as the Gateway API implementation:** fewer moving parts on EKS, but a second implementation to learn next to Envoy Gateway on kind, and dev/cloud parity is lost.
- **EKS Auto Mode:** less to manage, but it adds a per-instance fee and hides the node-level details this project is meant to teach.

## Consequences

- The Terraform layout, the Helm values file (`values-eks.yaml`), the deploy workflow, and the `make` targets are AWS-specific. The patterns (Helm, Gateway API, OIDC for CI, IAM for pods, ESO) transfer to AKS for the optional port.
- Public-IP nodes are a documented trade-off. Security groups must stay tight, and the README states the production alternative.
- The NLB created by the Load Balancer Controller is not in Terraform state. `make eks-down` must remove the Gateway's Service (so the NLB is deleted) before `terraform destroy`, or the VPC deletion fails.
- The pino-to-GCP `severity` mapping in `packages/observability` (from Phase 3) has no use on AWS. It is removed in Phase 9.
- Spot interruptions can restart pods at any time. This is accepted, and it doubles as chaos testing.
