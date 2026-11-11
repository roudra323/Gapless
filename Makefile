# Entry point for non-Node tooling (kind, helm, terraform). Targets are added per roadmap phase (docs/01).
.DEFAULT_GOAL := help

.PHONY: help
help: ## List the available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-16s %s\n", $$1, $$2}'

# --- Phase 8: local Kubernetes (docs/07 "Local cluster (kind)") ---
KIND_CLUSTER := gapless
KIND_CONFIG := deploy/local/kind-config.yaml
KUBE_CONTEXT := kind-$(KIND_CLUSTER)
KUBECTL := kubectl --context $(KUBE_CONTEXT)
HELM := helm --kube-context $(KUBE_CONTEXT)
# Envoy Gateway release (docs/04). Its CRD chart pins the Gateway API version it is tested with.
ENVOY_GATEWAY_VERSION := v1.10.0

.PHONY: kind-up
kind-up: ## Create the local kind cluster, then install the Gateway (safe to run again)
	@if kind get clusters 2>/dev/null | grep -qx '$(KIND_CLUSTER)'; then \
		echo "kind cluster '$(KIND_CLUSTER)' already exists"; \
	else \
		kind create cluster --name $(KIND_CLUSTER) --config $(KIND_CONFIG) --wait 120s; \
	fi
	@# Gateway API CRDs (standard channel) + Envoy Gateway CRDs. Server-side apply: the CRDs are too
	@# large for the client-side "last-applied" annotation.
	$(HELM) template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm --version $(ENVOY_GATEWAY_VERSION) \
		--set crds.gatewayAPI.enabled=true --set crds.gatewayAPI.channel=standard \
		--set crds.envoyGateway.enabled=true \
		| $(KUBECTL) apply --server-side -f -
	$(HELM) upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version $(ENVOY_GATEWAY_VERSION) \
		--namespace envoy-gateway-system --create-namespace --set crds.enabled=false --wait
	$(KUBECTL) apply -f deploy/local/gateway.yaml
	$(KUBECTL) -n envoy-gateway-system wait gateway/gapless-gateway --for=condition=Programmed --timeout=180s

.PHONY: kind-down
kind-down: ## Delete the local kind cluster and everything in it
	kind delete cluster --name $(KIND_CLUSTER)
