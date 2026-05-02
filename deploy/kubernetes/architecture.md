# GridDog — EKS Architecture (Singapore)

## Overview

GridDog runs in **Singapore (ap-southeast-1)** on an Amazon EKS cluster (`griddog-eks`, Kubernetes 1.30) with **3 managed node groups** (4 nodes total) inside the AWS **default VPC** (`172.31.0.0/16`). All app services run as Kubernetes Deployments / StatefulSets. A single ALB, provisioned dynamically by the AWS Load Balancer Controller from the Ingress YAML, fronts the cluster.

**Datadog observability is intentionally absent in v1** — app images still contain tracer libraries (orchestrion / dd-java-agent / dd-trace / CLR Profiler) but they no-op without an agent reachable. A follow-up plan will add the Datadog Operator + DatadogAgent CR + per-Deployment `DD_*` env vars.

---

## Cluster Fleet

| Node Group | Size | Instance | Subnets / AZ | Labels | Taints |
|---|---|---|---|---|---|
| `frontend` | 1 (max 2) | t3.medium | both private (1a + 1b) | `griddog.io/role=frontend` | none |
| `backend`  | **2** (max 4) | t3.medium | both private (1a + 1b) | `griddog.io/role=backend` | none |
| `databases` | 1 (max 1) | t3.medium | only private 1b (AZ-pinned) | `griddog.io/role=databases` | `griddog.io/role=databases:NoSchedule` |

Workload-to-node placement is enforced via `nodeSelector` on every Deployment / StatefulSet. Database pods also carry a matching `toleration`. Backend Deployments include `podAntiAffinity` (`topologyKey: kubernetes.io/hostname`) so the 2 replicas of each service land on different nodes — surviving a node failure with 50% capacity instead of 0%.

| Pod | Lands on | Replicas |
|---|---|---|
| `sg-k8s-nginx`            | frontend NG | 1 |
| `sg-k8s-frontend`         | frontend NG | 1 |
| `sg-k8s-traffic`          | frontend NG | 1 |
| `sg-k8s-backend`          | backend NG  | 2 (anti-affinity) |
| `sg-k8s-java-service`     | backend NG  | 2 (anti-affinity) |
| `sg-k8s-express-service`  | backend NG  | 2 (anti-affinity) |
| `sg-k8s-dotnet-scheduler` | backend NG  | 2 (anti-affinity) |
| `sg-k8s-postgres-0`       | databases NG (1b) | 1 (StatefulSet) |
| `sg-k8s-mongodb-0`        | databases NG (1b) | 1 (StatefulSet) |

---

## VPC and Subnet Setup

EKS reuses the **existing default VPC** rather than creating a new one. Four new subnets are added in unused CIDR space.

| Resource | CIDR | AZ | Type |
|---|---|---|---|
| VPC (referenced) | 172.31.0.0/16 (`vpc-0169d769cd12ce2ae`) | — | shared with VM stack |
| `griddog-eks-public-1a` | 172.31.80.0/24 | ap-southeast-1a | public, ALB AZ-1 |
| `griddog-eks-public-1b` | 172.31.81.0/24 | ap-southeast-1b | public, ALB AZ-2 |
| `griddog-eks-private-1a` | 172.31.82.0/24 | ap-southeast-1a | private, frontend/backend nodes |
| `griddog-eks-private-1b` | 172.31.83.0/24 | ap-southeast-1b | private, frontend/backend/databases nodes |

CIDR conflicts checked: avoids default-VPC auto subnets (172.31.0/20, 16/20, 32/20), unrelated RDS subnets (172.31.48-49.x), and the VM stack (172.31.64-66/24).

EKS-required tags applied automatically:
- All four: `kubernetes.io/cluster/griddog-eks=shared`
- Public: `kubernetes.io/role/elb=1`
- Private: `kubernetes.io/role/internal-elb=1`

**Shared NAT GW.** The EKS private route table sets `0.0.0.0/0 → griddog-nat-gw` (looked up via `data "aws_nat_gateway"` filtering on tag — owned by the VM stack). Saves ~$35/mo vs a dedicated NAT GW. Cost: VM stack must apply first; do not destroy it while EKS is running.

> **Why 2 public subnets if there's only 1 ALB?** AWS requires every ALB to span ≥2 subnets in different AZs (hard ALB constraint — gives the ALB internal AZ-level HA). The 2 public subnets here host the *single* `griddog-eks-alb`, exactly the same way the VM stack's `griddog-public` + `griddog-public-secondary` host the single `griddog-alb`.

---

## Request Flow

```
Browser
  │  HTTP :80
  ▼
ALB DNS  (k8s-griddoge-sgk8sng-<random>.ap-southeast-1.elb.amazonaws.com)
  │  restricted to admin CIDR + shared NAT EIP /32
  ▼
nginx Service (ClusterIP) → nginx pod (frontend NG)
  │
  └── nginx.conf path routing:
        /api/*  →  http://backend:8080   (Service → backend pods on backend NG)
        /health →  http://backend:8080
        /*      →  http://frontend:3000  (Service → frontend pod)

Inside backend pods (in-cluster Service DNS):
  Go backend  →  http://java-service:8081     (Spring Boot)
                ↘  http://express-service:3001  (Express.js)
                ↘  http://dotnet-scheduler:5000 (.NET 8)
                ↘  http://traffic:3002         (Puppeteer control API)

  Java/Go/.NET → postgres:5432   (StatefulSet headless Service)
  Express      → mongodb:27017

Puppeteer (sg-k8s-traffic):
  TRAFFIC_BASE_URL = http://<alb-dns>     (set post-apply via kubectl set env)
  Egress: traffic pod → NAT GW → internet → ALB → nginx → backend
```

---

## Service Addressing

K8s service discovery is the **only** addressing mechanism — no IP-templated env vars (unlike the VM stack). All cross-pod references use Service names; CoreDNS resolves them.

| Caller | Target | Address |
|---|---|---|
| Go backend | Java service | `http://java-service:8081` |
| Go backend | Express service | `http://express-service:3001` |
| Go backend | .NET scheduler | `http://dotnet-scheduler:5000` |
| Go backend | Traffic control | `http://traffic:3002` |
| Go backend, .NET | Postgres | `postgres:5432` |
| Java service | Postgres | `postgres:5432` (JDBC URL: `jdbc:postgresql://postgres:5432/griddog`) |
| Express service | MongoDB | `mongodb:27017` |
| nginx | frontend | `http://frontend:3000` |
| nginx | backend | `http://backend:8080` |
| Browser (frontend → backend) | same-origin | relative URL (`/api/...`) — browser supplies the page origin |
| Puppeteer | external ALB | `http://<alb-dns>` (set post-apply) |

---

## Security Groups

EKS manages most SGs automatically — no equivalent of the VM stack's per-service `griddog-ec2-*-sg` SGs needs to be created in v1.

| SG | Owner | Purpose |
|---|---|---|
| `eks-cluster-sg-griddog-eks-<random>` | EKS (auto) | All node-to-node and node-to-control-plane traffic |
| `k8s-griddoge-sgk8sng-<random>` | AWS Load Balancer Controller (dynamic, per Ingress) | ALB ingress allowlist driven by the `inbound-cidrs` annotation (admin IP + shared NAT EIP /32) |

Pod-level isolation is via Kubernetes NetworkPolicies if needed — out of scope for v1.

---

## Storage

Stateful workloads use the **`gp3` StorageClass** ([manifests/00-storage-class.yaml](manifests/00-storage-class.yaml)) with `volumeBindingMode: WaitForFirstConsumer`. The EBS CSI driver (installed as an EKS addon, IRSA-authenticated) provisions volumes in the same AZ as the pod that claims them.

| PVC | Mount | Size | Backed by |
|---|---|---|---|
| `data-sg-k8s-postgres-0` | `/var/lib/postgresql/data` | 8 GiB gp3 | EBS volume in 1b |
| `data-sg-k8s-mongodb-0` | `/data/db` | 8 GiB gp3 | EBS volume in 1b |

Initial data:
- Postgres `init.sql` (items + promo_codes seed) is inlined in [manifests/postgres.yaml](manifests/postgres.yaml) as a ConfigMap, mounted at `/docker-entrypoint-initdb.d/init.sql`. The SQL is a verbatim copy of [database/init.sql](../../database/init.sql) — when you change the schema, edit both files and redeploy postgres.
- MongoDB has no initial seed — Express service creates the `shop_items` collection on first use.

PVCs survive pod restarts; they only go away with `terraform destroy`. To preserve data across destroy, snapshot the volumes first.

---

## Health probes — key design choices

Every Deployment / StatefulSet has `readinessProbe` + `livenessProbe`. Two non-obvious decisions worth documenting:

| Service | Probe type | Why |
|---|---|---|
| Postgres | `exec: pg_isready -U griddog -d griddog` | `pg_isready` is a tiny native binary (~10ms) — fast and reliable as a probe |
| **MongoDB** | **`tcpSocket: 27017`** | `mongosh` is a Node.js app — cold-starts in 2-3s, exceeds the default 1s probe `timeoutSeconds`. TCP probe checks "is mongod listening?" in <100ms with no shell |
| backend / java / express / dotnet | `httpGet: /health` (or `/actuator/health`) | App-native HTTP endpoints |
| frontend | `httpGet: /` | Next.js root |
| nginx | `httpGet: /nginx-health` | Custom endpoint defined in `nginx.conf` (returns 200 "ok\n") |
| traffic | (none) | Crash-loops by design until `make wire-traffic` patches `TRAFFIC_BASE_URL` post-apply |

**Probe timing**: liveness probes have longer `initialDelaySeconds` than readiness (e.g. 30s vs 5s) so a slow-starting container is taken out of the Service endpoints (readiness fails) before being killed (liveness fails).

---

## Image Build Strategy (ECR)

No ECR migration story — images are built by the operator (or CI) and pushed to per-service ECR repos.

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  Local: docker build    │  push   │  ECR: 6 repos           │
│  (./scripts/build-and-  │ ──────▶ │  griddog/backend         │
│   push.sh)              │         │  griddog/java-service    │
└─────────────────────────┘         │  griddog/express-service │
                                    │  griddog/dotnet-scheduler│
┌─────────────────────────┐         │  griddog/frontend        │
│  CI: GitHub Actions     │  push   │  griddog/traffic         │
│  (OIDC, no AWS keys)    │ ──────▶ │                          │
│  .github/workflows/     │         │  Lifecycle: keep 10      │
│  build-images.yml       │         │  untagged                │
└─────────────────────────┘         └─────────────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────────────┐
                                    │  EKS pods pull from ECR │
                                    │  via the node IAM role  │
                                    └─────────────────────────┘
```

**Frontend rebuild trigger:** because the frontend uses **relative URLs** for backend calls (no `NEXT_PUBLIC_BACKEND_URL` baked in), the same image works in any environment. No per-environment rebuilds needed.

---

## Cost Estimate (Singapore, on-demand, monthly)

| Resource | Details | USD/mo |
|---|---|---|
| EKS control plane | $0.10/hr | $73 |
| 4× EC2 t3.medium | frontend 1 + backend 2 + databases 1 | $120 |
| NAT Gateway | shared with VM stack — $0 incremental | $0 |
| ALB | per LCU hour | $20 |
| EBS | 4× 30 GiB root + 2× 8 GiB data ≈ 136 GiB gp3 | $11 |
| ECR | minimal (~1 GiB total across repos) | $0.10 |
| **Total** | | **~$224/mo** |

`terraform destroy` brings EKS-specific cost to $0 (the VM stack's NAT GW is preserved).

---

## Comparison with the VM stack

| Concern | VM stack ([deploy/vm/](../vm/)) | EKS stack (this) |
|---|---|---|
| Compute | 4 EC2 instances (Ansible-managed Docker) | EKS cluster, 4 nodes, k8s-managed pods |
| Subnets | 3× 172.31.64-66/24 | 4× 172.31.80-83/24 |
| NAT GW | griddog-nat-gw (owned) | griddog-nat-gw (**shared**) |
| ALB | griddog-alb (Terraform `aws_lb`) | k8s-griddoge-* (AWS LB Controller, from Ingress) |
| Service discovery | Private IPs templated by Ansible into env vars | k8s Service names (CoreDNS) |
| Inter-service network | Docker bridge `griddog-net` (same EC2) + private IPs (cross-EC2) | Pod-to-pod via VPC CNI, Service ClusterIP |
| Storage | EBS volumes attached to databases EC2 | PVCs (EBS CSI), AZ-pinned to databases NG |
| Secrets | Ansible templated into compose files | k8s Secret `griddog-secrets`, env-from-secret |
| Image build | Built on each EC2 from cloned repo | Built locally / in CI, pushed to ECR |
| Datadog | Agent on every host | _(deferred)_ |
| Cost | ~$168/mo | ~$224/mo |

---

## Out of Scope (v1)

- Datadog observability wiring (deferred to follow-up plan)
- HPA / cluster autoscaler
- NetworkPolicies
- TLS termination on ALB
- Multi-region (would mean copy-pasting `manifests/` into `manifests-thailand/`)
- GitOps (Argo CD / Flux)
- Postgres / MongoDB backups (volume snapshots not automated)
