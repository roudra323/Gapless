# `infra/terraform` — GCP infrastructure

`bootstrap/`: GCS state bucket (local state, run once). `envs/dev/`: the real environment (GCS backend). Never `apply` or `destroy` unless the user asks.

- **Built in:** Phase 9
- **Read first:** `docs/07-infrastructure.md`, `docs/adr/0002-gke-standard-gateway-api.md`

No code yet. This folder is part of the skeleton.
