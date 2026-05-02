#!/usr/bin/env bash
# Build all gridDog service images and push to ECR.
# Usage:
#   ./scripts/build-and-push.sh                    # build all 6 services, tag=latest
#   TAG=$(git rev-parse --short HEAD) ./scripts/build-and-push.sh
#   SERVICES="frontend traffic" ./scripts/build-and-push.sh   # only build a subset
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
TAG="${TAG:-latest}"
SERVICES="${SERVICES:-backend java-service express-service dotnet-scheduler frontend traffic}"

# Find repo root (this script lives at deploy/kubernetes/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Logging into ECR ($REGISTRY)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

for svc in $SERVICES; do
  context="$REPO_ROOT/$svc"
  if [ ! -d "$context" ]; then
    echo "!! $svc: directory not found at $context — skipping" >&2
    continue
  fi
  if [ ! -f "$context/Dockerfile" ]; then
    echo "!! $svc: no Dockerfile in $context — skipping" >&2
    continue
  fi

  image="$REGISTRY/griddog/$svc:$TAG"
  echo "==> Building $svc → $image"
  docker build --platform linux/amd64 -t "$image" "$context"

  echo "==> Pushing $svc"
  docker push "$image"
done

echo "==> Done. Images tagged: $TAG"
