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
# kube-prometheus-stack chart (docs/04): Prometheus Operator, Prometheus, Grafana, Alertmanager.
KPS_VERSION := 92.22.0
# The Prometheus image of that chart, for promtool (`make rules-test`).
PROMETHEUS_IMAGE := quay.io/prometheus/prometheus:v3.16.0@sha256:9332054523223e2ddc18d8101799d54a4a8d823b030c53216f063a6c117773cd
CHART := deploy/helm/gapless
# The Kubernetes version that the chart is checked against (the EKS minor, docs/04).
KUBE_VERSION := 1.37.0
# JSON schemas for CRDs (HTTPRoute, later ServiceMonitor), pinned to a commit of the catalog.
CRD_SCHEMAS := https://raw.githubusercontent.com/datreeio/CRDs-catalog/49729e49e8f062933e3716a26540d41b0cd0856c/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json
# The image tag: the short git SHA (docs/07 "Pod standards"). Uncommitted changes add
# `-dirty-<hash of the diff>`, so a changed working tree gets a new tag and a new rollout.
ifndef IMAGE_TAG
IMAGE_TAG := $(shell git rev-parse --short HEAD)$(shell git diff --quiet HEAD || echo "-dirty-$$(git diff HEAD | shasum | cut -c1-8)")
endif

.PHONY: kind-up
kind-up: ## Create the kind cluster with the Gateway, monitoring, Postgres, anvil and the app Secret (safe to rerun)
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
	@# Monitoring: Prometheus (with the Operator and its CRDs), Grafana and Alertmanager.
	$(HELM) upgrade --install kube-prometheus-stack oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack \
		--version $(KPS_VERSION) --namespace monitoring --create-namespace \
		-f deploy/monitoring/kps-values.yaml --wait --timeout 10m
	@# The Operator creates Prometheus and Alertmanager after Helm returns, so Helm's --wait cannot see them.
	$(KUBECTL) -n monitoring wait statefulset/prometheus-kube-prometheus-stack-prometheus --for=create --timeout=120s
	$(KUBECTL) -n monitoring rollout status statefulset/prometheus-kube-prometheus-stack-prometheus \
		statefulset/alertmanager-kube-prometheus-stack-alertmanager --timeout=600s
	@# The app namespace, then the dev-only Postgres and anvil (never part of the app chart).
	$(KUBECTL) apply -f deploy/local/namespace.yaml
	$(KUBECTL) apply -f deploy/local/postgres.yaml -f deploy/local/anvil.yaml
	$(KUBECTL) -n gapless rollout status deployment/postgres deployment/anvil --timeout=180s
	@# The app Secret. Local dev values only (the same as docker-compose.yml); on EKS the External
	@# Secrets Operator fills it from AWS Secrets Manager. `create --dry-run | apply` makes it safe to rerun.
	$(KUBECTL) -n gapless create secret generic gapless-secrets \
		--from-literal=DATABASE_URL=postgres://gapless:gapless@postgres:5432/gapless \
		--from-literal=RPC_HTTP_URL=http://anvil:8545 \
		--from-literal=RPC_WS_URL=ws://anvil:8545 \
		--dry-run=client -o yaml | $(KUBECTL) apply -f -

.PHONY: rules-test
rules-test: ## Check the alert rules and run their unit tests with promtool
	docker run --rm -v "$(CURDIR)/deploy:/deploy:ro" -w /deploy/monitoring/tests --entrypoint /bin/promtool \
		$(PROMETHEUS_IMAGE) check rules /deploy/helm/gapless/rules/gapless.rules.yaml
	docker run --rm -v "$(CURDIR)/deploy:/deploy:ro" -w /deploy/monitoring/tests --entrypoint /bin/promtool \
		$(PROMETHEUS_IMAGE) test rules gapless.rules.test.yaml

.PHONY: kind-deploy
kind-deploy: ## Build both images, load them into kind, and deploy the chart (local values)
	docker build -f apps/indexer/Dockerfile --build-arg GIT_SHA=$(IMAGE_TAG) -t gapless-indexer:$(IMAGE_TAG) .
	docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(IMAGE_TAG) -t gapless-api:$(IMAGE_TAG) .
	kind load docker-image gapless-indexer:$(IMAGE_TAG) gapless-api:$(IMAGE_TAG) --name $(KIND_CLUSTER)
	$(HELM) upgrade --install gapless $(CHART) -n gapless -f $(CHART)/values-local.yaml \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m
	@echo "Deployed $(IMAGE_TAG). API: http://localhost:8080/v1/stats"

.PHONY: kind-down
kind-down: ## Delete the local kind cluster and everything in it
	kind delete cluster --name $(KIND_CLUSTER)

.PHONY: chart-lint
chart-lint: ## Lint the Helm chart and check the rendered manifests with kubeconform
	helm lint --strict $(CHART) -f $(CHART)/values-local.yaml --set image.tag=lint
	helm template gapless $(CHART) -n gapless -f $(CHART)/values-local.yaml --set image.tag=lint \
		| kubeconform -strict -summary -kubernetes-version $(KUBE_VERSION) \
			-schema-location default -schema-location '$(CRD_SCHEMAS)'
