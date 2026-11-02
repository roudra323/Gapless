# `infra/terraform` — AWS infrastructure

`bootstrap/`: S3 state bucket (local state, run once). `envs/dev/`: the real AWS environment (S3 backend, S3-native locking). `envs/aks/`: the optional Phase 11 AKS port. Never `apply` or `destroy` against AWS or Azure unless the user asks. Runs against the local Floci emulator (`make floci-apply`, Phase 9a) are free and allowed.

- **Built in:** Phase 9a (Floci), Phase 9b (AWS), Phase 11 (AKS, optional)
- **Read first:** `docs/07-infrastructure.md`, `docs/adr/0003-aws-eks-envoy-gateway.md`, `docs/adr/0004-floci-local-aws-emulator.md`

No code yet. This folder is part of the skeleton.
