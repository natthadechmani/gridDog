#!/usr/bin/env bash
# One-shot deploy of the GridDog stack onto an already-provisioned EKS cluster.
# Assumes Phase 1 (terraform apply) has already happened.
#
# Usage:
#   ./scripts/bootstrap.sh
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER_NAME="${CLUSTER_NAME:-griddog-eks}"
NAMESPACE="${NAMESPACE:-griddog}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MF="$KUBE_DIR/manifests"

echo "==> 1/8 Configuring kubectl"
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION"
kubectl get nodes

echo "==> 2/8 Cluster bootstrap (Namespace + StorageClass)"
kubectl apply -f "$MF/00-namespace.yaml"
kubectl apply -f "$MF/00-storage-class.yaml"

echo "==> 3/8 Applying Secrets"
"$SCRIPT_DIR/apply-secrets.sh"

echo "==> 4/8 Building & pushing images to ECR"
"$SCRIPT_DIR/build-and-push.sh"

echo "==> 5/8 Deploying databases (postgres, mongodb)"
kubectl apply -f "$MF/postgres.yaml"
kubectl apply -f "$MF/mongodb.yaml"

echo "==> 6/8 Deploying app tier (java, express, dotnet, backend)"
# Deploy in dependency order: java/express/dotnet first, then backend
# (backend's healthchecks expect the others to respond).
kubectl apply -f "$MF/java-service.yaml"
kubectl apply -f "$MF/express-service.yaml"
kubectl apply -f "$MF/dotnet-scheduler.yaml"
kubectl apply -f "$MF/backend.yaml"

echo "==> 7/8 Deploying edge tier (frontend, traffic, nginx)"
kubectl apply -f "$MF/frontend.yaml"
kubectl apply -f "$MF/traffic.yaml"
kubectl apply -f "$MF/nginx.yaml"

echo "    Waiting for pods to be Ready (up to 10 min)..."
kubectl -n "$NAMESPACE" wait --for=condition=ready pod \
  -l app.kubernetes.io/part-of=griddog --timeout=10m || {
  echo "!! Some pods didn't become Ready (traffic crash-loops until Step 8 — this is expected)."
}

echo "==> 8/8 Wiring traffic generator to ALB DNS"
ALB=""
for i in {1..30}; do
  ALB=$(kubectl -n "$NAMESPACE" get ingress sg-k8s-nginx \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  [ -n "$ALB" ] && break
  echo "    waiting for ALB DNS... ($i/30)"
  sleep 10
done

if [ -z "$ALB" ]; then
  echo "!! ALB DNS never appeared. Check 'kubectl -n $NAMESPACE describe ingress sg-k8s-nginx'."
  exit 1
fi

echo "    ALB DNS: $ALB"
kubectl -n "$NAMESPACE" set env deployment/sg-k8s-traffic TRAFFIC_BASE_URL="http://$ALB"

echo
echo "==> Done."
echo "    Open: http://$ALB/"
echo "    Health check:  curl http://$ALB/nginx-health"
