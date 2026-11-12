# `deploy` — Kubernetes and monitoring

`helm/gapless/`: the app chart. `local/`: the kind config, the local Gateway, and the dev-only namespace, Postgres and anvil manifests. `monitoring/`: kube-prometheus-stack, Loki and Alloy values, and `dashboards/*.json`. `load/`: the k6 load script.

- **Built in:** Phase 8 (local), Phase 9 (EKS values)
- **Read first:** `docs/07-infrastructure.md`, `docs/09-observability.md`

Validate the chart with `make chart-lint` (`helm lint` and `helm template … | kubeconform -strict`, see `docs/07`). Prettier skips `helm/gapless/templates/`, because Helm templates are not plain YAML.
