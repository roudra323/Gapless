# `infra/terraform` — AWS infrastructure

`bootstrap/`: S3 state bucket (local state, run once). `envs/dev/`: the real AWS environment (S3 backend, S3-native locking). `envs/aks/`: the optional Phase 11 AKS port. Never `apply` or `destroy` unless the user asks.

- **Built in:** Phase 9 (AWS), Phase 11 (AKS, optional)
- **Read first:** `docs/07-infrastructure.md`, `docs/adr/0003-aws-eks-envoy-gateway.md`

No code yet. This folder is part of the skeleton.
