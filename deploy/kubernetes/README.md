# GridDog — EKS Deployment Guide

Deploys GridDog as a stack of containers on Amazon EKS, mirroring the application surface of the VM stack ([deploy/vm/](../vm/)). Same 9 services (postgres, mongodb, backend, java-service, express-service, dotnet-scheduler, frontend, traffic, nginx), same Singapore region, same external entry point — but on Kubernetes.

> See [architecture.md](architecture.md) for cluster topology, request flow, and resource layout. See [terraform/README.md](terraform/README.md) for infrastructure provisioning.

This stack uses **plain Kubernetes YAML** — one self-contained file per service in [manifests/](manifests/). No Kustomize, no Helm, no templating. Each file deploys with `kubectl apply -f manifests/<service>.yaml`.

---

## Make targets cheat sheet

All commands run from `deploy/kubernetes/` (where the Makefile lives).

```bash
make help                         # list all targets

# First-time deploy (in order — or just `make bootstrap` to chain everything)
make init                         # terraform init
make plan                         # terraform plan
make infra                        # terraform apply (~15-20 min)
make kubeconfig                   # aws eks update-kubeconfig
make namespace                    # apply manifests/00-namespace.yaml
make storage-class                # apply manifests/00-storage-class.yaml
make secrets                      # apply Secret from secrets.env (via apply-secrets.sh)
make images                       # docker build + push 6 images to ECR (~10 min first run)
make deploy-databases             # apply postgres + mongodb
make deploy-app                   # apply java + express + dotnet + backend
make deploy-edge                  # apply frontend + traffic + nginx
make wait                         # wait for all gridDog pods to become Ready
make wire-traffic                 # patch traffic with the real ALB DNS

# Day-2 per-service workflow (set SVC=<name>)
make deploy-svc  SVC=backend      # apply manifests/backend.yaml + wait for rollout
make restart-svc SVC=backend      # rollout restart (e.g. after secret rotation)
make logs-svc    SVC=backend      # tail logs

# Shortcuts
make bootstrap                    # runs scripts/bootstrap.sh = chains Steps 2-8 below
make destroy                      # deletes manifests in reverse, waits, then terraform destroy
```

> The Makefile is just a convenience wrapper around `kubectl apply -f` and the helper scripts. Anything `make` does, you can do by hand — see the per-step instructions below.

### `make` 101 (if you haven't used it)

`make` is a CLI tool. It reads the [Makefile](Makefile) in the current directory and runs whatever commands are listed under the target you typed:

```
make <target>     ↓
                Looks up `<target>:` in Makefile, runs the indented commands beneath it.
```

Useful tricks:
```bash
make help                         # list available targets (defined at top of Makefile)
make -n deploy-databases          # dry-run: print what would happen, don't run it
make NAMESPACE=other-ns deploy-svc SVC=backend   # override variables on the command line
```

Targets like `make deploy-svc` use `SVC=` for the per-service operation. So `make deploy-svc SVC=backend` re-applies just `manifests/backend.yaml` and waits for the rollout. Same for `make restart-svc SVC=...` and `make logs-svc SVC=...`.

---

## Prerequisites

```bash
# Tools
brew install awscli terraform kubectl
brew install --cask docker

# AWS SSO
aws sso login --profile griddog
export AWS_PROFILE=griddog
aws sts get-caller-identity --profile griddog

# Frontend code change (one-time): the frontend uses relative URLs so the
# same image works in any environment. If you haven't, edit
#   frontend/app/lib/shop.ts          (line setting BACKEND_URL)
#   frontend/app/components/Dashboard.tsx
# to default `process.env.NEXT_PUBLIC_BACKEND_URL || ''` instead of `|| 'http://localhost:8080'`.
```

---

## File layout

```
deploy/kubernetes/
├── manifests/                    # Plain k8s YAML, one file per concern
│   ├── 00-namespace.yaml         # bootstrap: griddog Namespace
│   ├── 00-storage-class.yaml     # bootstrap: gp3 StorageClass (cluster-scoped)
│   ├── secrets.yaml.example      # template for the Secret (real one applied via apply-secrets.sh)
│   ├── postgres.yaml             # StatefulSet + Service + ConfigMap (init.sql inlined)
│   ├── mongodb.yaml              # StatefulSet + Service
│   ├── java-service.yaml         # Deployment + Service (port 8081)
│   ├── express-service.yaml      # Deployment + Service (port 3001)
│   ├── dotnet-scheduler.yaml     # Deployment + Service (port 5000)
│   ├── backend.yaml              # Deployment + Service (port 8080) — talks to all 3 above
│   ├── frontend.yaml             # Deployment + Service (port 3000)
│   ├── traffic.yaml              # Deployment + Service (port 3002)
│   └── nginx.yaml                # Deployment + Service + ConfigMap + Ingress (provisions ALB)
│
├── terraform/                    # Cluster + ECR + IAM (Phase 1)
│   └── README.md
│
├── scripts/
│   ├── apply-secrets.sh          # Create k8s Secret from secrets.env
│   ├── build-and-push.sh         # docker build + push 6 images to ECR
│   └── bootstrap.sh              # One-shot deploy after terraform apply
│
├── Makefile                      # Convenience targets (make help to list)
├── secrets.env.example           # Template (real one gitignored)
├── README.md                     # This file
└── architecture.md
```

Each file in `manifests/` is **fully self-contained**. Names are `sg-k8s-*`, namespace is `griddog`, image URLs point at ECR account `369042512949`, all hardcoded directly into the YAML. To deploy any one of them: `kubectl apply -f manifests/<file>.yaml`.

---

## Step-by-step deployment

### Step 1 — Provision EKS infrastructure (Terraform)

```bash
cd deploy/kubernetes/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars                    # set admin_cidrs = ["<your-ip>/32"]

terraform init
terraform plan
terraform apply                              # ~15-20 min
```

Outputs you'll need:
```bash
terraform output ecr_registry                # 369042512949.dkr.ecr.ap-southeast-1.amazonaws.com
terraform output -raw shared_nat_eip         # for the Ingress allowlist
```

### Step 2 — Configure kubectl

```bash
aws eks update-kubeconfig --name griddog-eks --region ap-southeast-1
kubectl get nodes                            # 4 nodes Ready
```

### Step 3 — Cluster bootstrap (Namespace + StorageClass)

These two are cluster-level prerequisites for everything else:

```bash
cd deploy/kubernetes
kubectl apply -f manifests/00-namespace.yaml
kubectl apply -f manifests/00-storage-class.yaml
```

### Step 4 — Apply Secrets

```bash
cp secrets.env.example secrets.env
$EDITOR secrets.env                          # set db_password
./scripts/apply-secrets.sh                   # creates Secret griddog-secrets
```

### Step 5 — Update the Ingress allowlist for your IP

The Ingress in `manifests/nginx.yaml` has a hardcoded `inbound-cidrs` annotation listing the admin IP and the NAT EIP. If your IP has changed since the last deploy, update line 137:

```yaml
alb.ingress.kubernetes.io/inbound-cidrs: "<your-ip>/32,3.1.4.47/32"
```

Get your current IP: `curl ifconfig.me`. The NAT EIP is from `terraform output -raw shared_nat_eip` and rarely changes.

### Step 6 — Build & push images to ECR

```bash
./scripts/build-and-push.sh                  # ~10 min first time
```

### Step 7 — Deploy services in order

```bash
# Tier 1 — databases
kubectl apply -f manifests/postgres.yaml
kubectl apply -f manifests/mongodb.yaml

# Tier 2 — app services (dependencies of backend, deploy before backend)
kubectl apply -f manifests/java-service.yaml
kubectl apply -f manifests/express-service.yaml
kubectl apply -f manifests/dotnet-scheduler.yaml

# Tier 3 — backend (waits on java + express healthchecks)
kubectl apply -f manifests/backend.yaml

# Tier 4 — edge
kubectl apply -f manifests/frontend.yaml
kubectl apply -f manifests/traffic.yaml      # crash-loops until step 8 — expected
kubectl apply -f manifests/nginx.yaml        # creates the Ingress → provisions the ALB
```

Watch in another terminal:
```bash
kubectl -n griddog get pods -w
```

### Step 8 — Wire traffic generator to the real ALB DNS

```bash
ALB=""
for i in {1..30}; do
  ALB=$(kubectl -n griddog get ingress sg-k8s-nginx \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  [ -n "$ALB" ] && break
  echo "waiting for ALB DNS... ($i/30)"; sleep 10
done
echo "ALB: $ALB"

kubectl -n griddog set env deployment/sg-k8s-traffic TRAFFIC_BASE_URL=http://$ALB
```

### Step 9 — Validate

```bash
# In-cluster
kubectl -n griddog get pods                  # all Running 1/1
kubectl -n griddog get pvc                   # postgres-data + mongodb-data Bound
kubectl -n griddog exec sg-k8s-postgres-0 -- psql -U griddog -c "\dt"

# External
curl http://$ALB/nginx-health                # 200
curl http://$ALB/health                      # 200, proxied to backend
curl -s http://$ALB/api/flow/1 | jq          # JSON

open http://$ALB/                            # browser → all 10 flow cards
```

---

## The `bootstrap.sh` shortcut

Once Terraform is applied, `bootstrap.sh` chains Steps 2-8 into one command:

```bash
./scripts/bootstrap.sh
```

Or via Make:
```bash
make bootstrap
```

Idempotent — re-running re-applies state without breaking anything.

---

## Day-2 operations (per-service workflow)

This is the workflow for "treat each service like a different team owns it."

### Code change → roll out new image

```bash
# 1. Build + push the new image with a unique tag (e.g. git SHA)
TAG=$(git rev-parse --short HEAD)
SERVICES=backend ./scripts/build-and-push.sh

# 2. Tell k8s to use the new image (rolling update, zero downtime)
kubectl -n griddog set image deployment/sg-k8s-backend \
  backend=369042512949.dkr.ecr.ap-southeast-1.amazonaws.com/griddog/backend:$TAG

# 3. Watch the rollout
kubectl -n griddog rollout status deployment/sg-k8s-backend
```

Other services are completely untouched — they keep running their current image.

### Manifest change to one service

Edit the file, then re-apply just that one:

```bash
$EDITOR manifests/express-service.yaml
kubectl apply -f manifests/express-service.yaml
kubectl -n griddog rollout status deployment/sg-k8s-express-service
```

Or via Make:
```bash
make deploy-svc SVC=express-service
```

### Restart a service without changing anything (e.g. after Secret rotation)

```bash
kubectl -n griddog rollout restart deployment/sg-k8s-backend
```

Or:
```bash
make restart-svc SVC=backend
```

### Tail logs

```bash
kubectl -n griddog logs -f deployment/sg-k8s-backend
make logs-svc SVC=backend
```

### Other useful one-liners

```bash
# Scale a service
kubectl -n griddog scale deployment/sg-k8s-backend --replicas=3

# Shell into a pod
kubectl -n griddog exec -it deploy/sg-k8s-backend -- sh

# See what's deployed
kubectl -n griddog get all

# Re-apply secrets after editing secrets.env
./scripts/apply-secrets.sh
kubectl -n griddog rollout restart deployment   # pick up new env vars
```

---

## Teardown

```bash
# 1. Delete app resources first so the AWS LB Controller cleans up the ALB
make destroy
# (or do it manually:
#  for f in nginx traffic frontend backend dotnet-scheduler express-service java-service mongodb postgres; do
#    kubectl delete -f manifests/$f.yaml --ignore-not-found
#  done)

# 2. terraform destroy is part of `make destroy` — it waits 60s for ALB cleanup first

# 3. (Optional) delete ECR repos
for svc in backend java-service express-service dotnet-scheduler frontend traffic; do
  aws ecr delete-repository --repository-name griddog/$svc --force --region ap-southeast-1
done
```

> **WARNING:** never `terraform destroy` the VM stack while EKS is running — EKS pods would lose internet egress (shared NAT GW dependency).

---

## Common issues & fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Unable to connect to the server: getting credentials: exec: executable aws failed` | AWS SSO token expired | `aws sso login --profile griddog && export AWS_PROFILE=griddog` |
| `terraform apply` fails `AccessDenied` | Same — SSO expired | `aws sso login --profile griddog` |
| `kubectl get nodes` returns nothing | kubeconfig not pointing at the cluster | `aws eks update-kubeconfig --name griddog-eks --region ap-southeast-1` |
| `Warning: resource X is missing the kubectl.kubernetes.io/last-applied-configuration annotation ... patched automatically` | Resource was created via `kubectl create` (or another tool) — apply needs an annotation it tracks itself | **Harmless, one-time.** apply auto-patches and future applies are silent |
| `Error: creating IAM OIDC Provider ... EntityAlreadyExists` (during terraform apply) | Another project in the AWS account already created the GitHub OIDC provider | Already handled — [iam.tf](terraform/iam.tf) uses a `data` lookup. If you see this, re-pull from the repo and re-apply |
| Postgres pod `Pending` | gp3 StorageClass missing | `make storage-class` (or `kubectl apply -f manifests/00-storage-class.yaml`) |
| Postgres/MongoDB pod `Pending`, `kubectl describe pvc` shows "WaitForFirstConsumer" | Normal — gp3 SC waits to know which AZ the pod lands on before provisioning the EBS volume. Resolves once the pod is scheduled. | Wait ~30s |
| Backend pod `Pending`, events say "didn't match pod anti-affinity rules" | Only 1 backend node up; anti-affinity refuses to co-locate the 2 replicas | `kubectl describe nodes -l griddog.io/role=backend` — should show 2 Ready nodes. If only 1, check the EKS managed node group desired count |
| `ImagePullBackOff` | Image not in ECR, or wrong account ID in YAML | `make images`; verify `image:` URL in the manifest matches `terraform output ecr_registry` |
| MongoDB pod restarting with `Reason: Completed`, events show `command "mongosh ..." timed out` | Liveness probe timeout — `mongosh` (Node.js) takes 2-3s to cold-start, exceeds default 1s probe timeout | Already handled — [manifests/mongodb.yaml](manifests/mongodb.yaml) uses `tcpSocket` probes (faster, no shell). If you see this, force-roll the pod: `kubectl -n griddog delete pod sg-k8s-mongodb-0` |
| Ingress has no ADDRESS field after 5 min | AWS Load Balancer Controller broken or IRSA misconfigured | `kubectl logs -n kube-system deploy/aws-load-balancer-controller` — look for IAM permission errors |
| Traffic pod `CrashLoopBackOff`, env shows `TRAFFIC_BASE_URL=http://pending` | Step 8 / `make wire-traffic` not run yet | `make wire-traffic` (or run the `kubectl set env` from Step 8) |
| ALB returns `403 Forbidden` from your browser | Your IP isn't in the Ingress `inbound-cidrs` allowlist | Edit `manifests/nginx.yaml`, update the `alb.ingress.kubernetes.io/inbound-cidrs` annotation, then `make deploy-svc SVC=nginx`. Get current IP: `curl ifconfig.me` |
| StatefulSet doesn't roll a pod after editing the manifest | Existing pod hasn't picked up new spec yet (or rolling update is stuck on probe failures) | `kubectl -n griddog delete pod sg-k8s-<svc>-0` — controller recreates with the current spec |
| `kubectl apply -f manifests/...` returns "Unable to connect to the server" | SSO expired mid-session | `aws sso login --profile griddog` (kubectl uses your current AWS creds via the IAM authenticator) |

---

## Why plain YAML and not Kustomize/Helm

Kustomize and Helm are abstractions that pay off when you have:
- Multiple environments (Singapore + Thailand + …)
- Many services with shared boilerplate
- A team large enough that the duplication tax is worse than the abstraction tax

GridDog is a single-cluster sandbox owned by one person. Plain YAML wins on:
- **Clarity**: what you see in the file is exactly what gets sent to the cluster, byte for byte
- **Tooling familiarity**: standard `kubectl apply -f` works for everything, no extra CLI to learn
- **Per-service workflow**: one file per service, deploy independently with no overlay or release-tracking gymnastics

The cost: when ECR account or namespace changes, you edit 9 files instead of 1. For a sandbox, that's fine.
