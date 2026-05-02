#!/usr/bin/env bash
# Apply (or update) the griddog-secrets Secret in the griddog namespace,
# reading values from the gitignored secrets.env file.
#
# Usage:
#   ./scripts/apply-secrets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_ENV="$KUBE_DIR/secrets.env"
NAMESPACE="${NAMESPACE:-griddog}"

if [ ! -f "$SECRETS_ENV" ]; then
  echo "!! $SECRETS_ENV not found." >&2
  echo "   cp $KUBE_DIR/secrets.env.example $SECRETS_ENV   then edit." >&2
  exit 1
fi

echo "==> Ensuring namespace $NAMESPACE exists"
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

echo "==> Applying Secret griddog-secrets in namespace $NAMESPACE"
kubectl create secret generic griddog-secrets \
  --namespace="$NAMESPACE" \
  --from-env-file="$SECRETS_ENV" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo "==> Done."
