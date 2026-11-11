# Entry point for non-Node tooling (kind, helm, terraform). Targets are added per roadmap phase (docs/01).
.DEFAULT_GOAL := help

.PHONY: help
help: ## List the available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-16s %s\n", $$1, $$2}'

# --- Phase 8: local Kubernetes (docs/07 "Local cluster (kind)") ---
KIND_CLUSTER := gapless
KIND_CONFIG := deploy/local/kind-config.yaml

.PHONY: kind-up
kind-up: ## Create the local kind cluster (does nothing if it exists)
	@if kind get clusters 2>/dev/null | grep -qx '$(KIND_CLUSTER)'; then \
		echo "kind cluster '$(KIND_CLUSTER)' already exists"; \
	else \
		kind create cluster --config $(KIND_CONFIG) --wait 120s; \
	fi

.PHONY: kind-down
kind-down: ## Delete the local kind cluster and everything in it
	kind delete cluster --name $(KIND_CLUSTER)
