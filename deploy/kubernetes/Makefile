.PHONY: help init plan infra kubeconfig namespace storage-class secrets images \
        deploy-databases deploy-app deploy-edge deploy wait wire-traffic \
        bootstrap diff-svc destroy

NAMESPACE ?= griddog
REGION ?= ap-southeast-1
CLUSTER_NAME ?= griddog-eks
SVC ?= backend          # used by 'make deploy-svc' / 'make logs' / etc.

help:
	@echo "GridDog EKS — common commands"
	@echo ""
	@echo "First-time deploy (run in order, or use 'make bootstrap'):"
	@echo "  make init              terraform init"
	@echo "  make plan              terraform plan"
	@echo "  make infra             terraform apply (cluster + ECR + IAM)"
	@echo "  make kubeconfig        aws eks update-kubeconfig"
	@echo "  make namespace         apply namespace"
	@echo "  make storage-class     apply gp3 StorageClass"
	@echo "  make secrets           apply Secret from secrets.env"
	@echo "  make images            docker build + push to ECR"
	@echo "  make deploy-databases  apply postgres + mongodb"
	@echo "  make deploy-app        apply java + express + dotnet + backend"
	@echo "  make deploy-edge       apply frontend + traffic + nginx"
	@echo "  make wait              wait until all gridDog pods are Ready"
	@echo "  make wire-traffic      kubectl set env on traffic with ALB DNS"
	@echo ""
	@echo "Per-service operations (set SVC=, e.g. make deploy-svc SVC=backend):"
	@echo "  make deploy-svc        apply manifests/\$$(SVC).yaml"
	@echo "  make restart-svc       kubectl rollout restart"
	@echo "  make logs-svc          tail logs"
	@echo ""
	@echo "Shortcuts:"
	@echo "  make bootstrap         scripts/bootstrap.sh (chains everything below kubeconfig)"
	@echo "  make destroy           delete app resources, then terraform destroy"

# ---- Infra (Terraform) ------------------------------------------------------

init:
	cd terraform && terraform init

plan:
	cd terraform && terraform plan

infra:
	cd terraform && terraform apply

kubeconfig:
	aws eks update-kubeconfig --name $(CLUSTER_NAME) --region $(REGION)

# ---- Cluster bootstrap (one-time) -------------------------------------------

namespace:
	kubectl apply -f manifests/00-namespace.yaml

storage-class:
	kubectl apply -f manifests/00-storage-class.yaml

secrets:
	./scripts/apply-secrets.sh

images:
	./scripts/build-and-push.sh

# ---- Apply by tier ----------------------------------------------------------

deploy-databases:
	kubectl apply -f manifests/postgres.yaml
	kubectl apply -f manifests/mongodb.yaml

deploy-app:
	kubectl apply -f manifests/java-service.yaml
	kubectl apply -f manifests/express-service.yaml
	kubectl apply -f manifests/dotnet-scheduler.yaml
	kubectl apply -f manifests/backend.yaml

deploy-edge:
	kubectl apply -f manifests/frontend.yaml
	kubectl apply -f manifests/traffic.yaml
	kubectl apply -f manifests/nginx.yaml

deploy: deploy-databases deploy-app deploy-edge

wait:
	kubectl -n $(NAMESPACE) wait --for=condition=ready pod \
		-l app.kubernetes.io/part-of=griddog --timeout=10m || true

wire-traffic:
	@ALB=$$(kubectl -n $(NAMESPACE) get ingress sg-k8s-nginx \
		-o jsonpath='{.status.loadBalancer.ingress[0].hostname}'); \
	if [ -z "$$ALB" ]; then echo "!! ALB DNS not ready yet"; exit 1; fi; \
	echo "ALB: $$ALB"; \
	kubectl -n $(NAMESPACE) set env deployment/sg-k8s-traffic TRAFFIC_BASE_URL=http://$$ALB

# ---- Per-service operations -------------------------------------------------

deploy-svc:
	kubectl apply -f manifests/$(SVC).yaml
	@kubectl -n $(NAMESPACE) rollout status deployment/sg-k8s-$(SVC) --timeout=5m 2>/dev/null \
	  || kubectl -n $(NAMESPACE) rollout status statefulset/sg-k8s-$(SVC) --timeout=5m

restart-svc:
	@kubectl -n $(NAMESPACE) rollout restart deployment/sg-k8s-$(SVC) 2>/dev/null \
	  || kubectl -n $(NAMESPACE) rollout restart statefulset/sg-k8s-$(SVC)

logs-svc:
	kubectl -n $(NAMESPACE) logs -f deployment/sg-k8s-$(SVC) 2>/dev/null \
	  || kubectl -n $(NAMESPACE) logs -f statefulset/sg-k8s-$(SVC)

# ---- Shortcuts --------------------------------------------------------------

bootstrap:
	./scripts/bootstrap.sh

destroy:
	@echo "Deleting app resources first so the AWS LB Controller cleans up the ALB..."
	-kubectl delete -f manifests/nginx.yaml --ignore-not-found
	-kubectl delete -f manifests/traffic.yaml --ignore-not-found
	-kubectl delete -f manifests/frontend.yaml --ignore-not-found
	-kubectl delete -f manifests/backend.yaml --ignore-not-found
	-kubectl delete -f manifests/dotnet-scheduler.yaml --ignore-not-found
	-kubectl delete -f manifests/express-service.yaml --ignore-not-found
	-kubectl delete -f manifests/java-service.yaml --ignore-not-found
	-kubectl delete -f manifests/mongodb.yaml --ignore-not-found
	-kubectl delete -f manifests/postgres.yaml --ignore-not-found
	@echo "Waiting 60s for ALB to be deleted before terraform destroy..."
	@sleep 60
	cd terraform && terraform destroy
