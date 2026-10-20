# ADR-0002 — GKE Standard (zonal) + Gateway API

- **Status:** Accepted
- **Date:** 2026-10-21

## Context
The project needs real Kubernetes experience on a major cloud, kube-prometheus-stack (including node-level exporters), and low cost. ingress-nginx was retired in March 2026.

## Decision
- **GKE Standard, zonal**, on a small Spot node pool. The free tier covers one zonal cluster's management fee, and Standard allows privileged monitoring components that Autopilot restricts.
- **Gateway API** for north-south traffic: Envoy Gateway on kind, and the GKE Gateway controller on GKE. No `Ingress` resources.

## Alternatives considered
- **GKE Autopilot:** less to manage, but its workload restrictions complicate kube-prometheus-stack, and you learn less about nodes.
- **EKS:** common in job postings, but there's an hourly control-plane fee and more setup. The patterns here (Helm, Gateway API, Workload Identity-style IAM, Terraform) transfer to EKS.

## Consequences
- We manage node pool sizing and upgrades (on auto-upgrade with the REGULAR channel).
- Spot preemption can restart pods at any time. This is accepted, and it doubles as chaos testing.
