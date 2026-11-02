# `deploy` — Kubernetes and monitoring

`helm/gapless/`: the app chart. `local/`: kind config and the dev-only Postgres manifest. `monitoring/`: kube-prometheus-stack, Loki and Alloy values, and `dashboards/*.json`. `load/`: the k6 load script.

- **Built in:** Phase 8 (local), Phase 9 (EKS values)
- **Read first:** `docs/07-infrastructure.md`, `docs/09-observability.md`

No code yet. This folder is part of the skeleton.
