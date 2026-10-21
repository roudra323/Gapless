# Gapless

A resilient ERC-20 `Transfer` indexer and read API: no gaps, no duplicates, survives WebSocket drops, RPC errors, reorgs, and restarts. Runs on Kubernetes (kind locally, GKE in the cloud) with Terraform, GitHub Actions, and Prometheus/Grafana.

> **Status:** Phase 0 (repo foundation) done. Next: Phase 1. See [`docs/01-overview-and-roadmap.md`](docs/01-overview-and-roadmap.md).

## Docs

| Doc                                      | Topic                                              |
| ---------------------------------------- | -------------------------------------------------- |
| [01](docs/01-overview-and-roadmap.md)    | Overview, demo, roadmap and current phase          |
| [02](docs/02-architecture.md)            | Architecture, repo layout, data model, API, config |
| [03](docs/03-indexer-design.md)          | Indexer design and invariants                      |
| [04](docs/04-tech-stack-and-versions.md) | Tech stack, version policy, banned tools           |
| [05](docs/05-coding-conventions.md)      | Coding conventions                                 |
| [06](docs/06-testing.md)                 | Testing                                            |
| [07](docs/07-infrastructure.md)          | Docker, Kubernetes, Helm, Terraform                |
| [08](docs/08-ci-cd.md)                   | CI/CD                                              |
| [09](docs/09-observability.md)           | Metrics, alerts, dashboards, logs                  |
| [adr/](docs/adr/)                        | Architecture decision records                      |

Contributor and agent rules: [`CLAUDE.md`](CLAUDE.md).
