# GridDog — AWS EC2 Deployment Architecture (Singapore)

## Overview

GridDog runs in **Singapore (ap-southeast-1)** on **4 EC2 instances** inside the AWS
**default VPC** (`172.31.0.0/16`). All app services run as Docker containers managed
by **Docker Compose**, deployed via **Ansible** (see [ansible/README.md](ansible/README.md)).
Infrastructure is provisioned with **Terraform** (see [terraform/README.md](terraform/README.md)).

Cross-EC2 service discovery uses **private IPs** templated into env vars by Ansible.
Same-EC2 services share a Docker bridge network (`griddog_network`) and reach each
other by container name. There is **no Route 53 private hosted zone**.

---

## EC2 Fleet

| EC2 Name | Containers | Instance Type | Subnet |
|---|---|---|---|
| `griddog-nginx` | nginx (:80) | t3.micro | Public `172.31.64.0/24` (1b) |
| `griddog-frontend` | griddog-frontend (Next.js :3000), griddog-traffic (Puppeteer :3002) | t3.medium | Private `172.31.66.0/24` (1b) |
| `griddog-app` | griddog-backend (Go :8080), griddog-java-service (:8081), griddog-express-service (:3001), griddog-dotnet-scheduler (:5000) | t3.medium | Private `172.31.66.0/24` (1b) |
| `griddog-databases` | postgres (:5432), mongodb (:27017) | t3.medium | Private `172.31.66.0/24` (1b) |

> nginx is the only EC2 with a public IP. It also acts as the **SSH bastion** (jump host) for the three private EC2s.

---

## VPC and Subnet Setup

GridDog reuses the existing **default VPC** rather than creating a new one. Three new
subnets are added inside the default VPC's CIDR space (`172.31.0.0/16`).

| Resource | Value |
|---|---|
| VPC | default VPC `vpc-0169d769cd12ce2ae` (CIDR `172.31.0.0/16`) — **referenced**, not created |
| Internet Gateway | existing IGW attached to default VPC — **referenced**, not created |
| Public subnet (primary) | `172.31.64.0/24` in ap-southeast-1b — nginx + NAT GW + ALB |
| Public subnet (secondary) | `172.31.65.0/24` in ap-southeast-1a — ALB only (AWS requires min 2 AZs for ALB) |
| Private subnet | `172.31.66.0/24` in ap-southeast-1b — frontend, app, databases |
| NAT Gateway | `griddog-nat-gw` + Elastic IP, in public subnet — egress for private subnet |
| ALB | `griddog-alb`, public, HTTP :80 → nginx EC2 |

```
Default VPC (172.31.0.0/16)  — existing, referenced
│
├── Public Subnet (NEW): 172.31.64.0/24  (ap-southeast-1b)
│   ├── Existing Internet Gateway (shared with default VPC)
│   ├── NAT Gateway + Elastic IP (griddog-nat-gw)
│   ├── EC2: griddog-nginx (public IP, also SSH bastion)
│   └── ALB (one of two AZs)
│
├── Public Subnet (NEW): 172.31.65.0/24  (ap-southeast-1a)
│   └── ALB (second AZ — required by AWS, no EC2)
│
└── Private Subnet (NEW): 172.31.66.0/24  (ap-southeast-1b)
    ├── EC2: griddog-frontend  (Next.js :3000 + Puppeteer :3002)
    ├── EC2: griddog-app       (Go :8080 + Java :8081 + Express :3001 + .NET :5000)
    └── EC2: griddog-databases (Postgres :5432 + MongoDB :27017)
```

---

## Request Flow

```
Browser
  → ALB DNS  (griddog-alb-xxxx.ap-southeast-1.elb.amazonaws.com)
    → ALB :80  (HTTP, restricted to alb_allowed_cidrs)
      → griddog-nginx :80
        ├── /api/* → griddog-app  <app_private_ip>:8080  (Go backend)
        │     ├── http://java-service:8081     (same EC2, Docker bridge)
        │     │     └── postgres @ <databases_private_ip>:5432
        │     ├── http://express-service:3001  (same EC2, Docker bridge)
        │     │     └── mongodb  @ <databases_private_ip>:27017
        │     └── http://dotnet-scheduler:5000 (same EC2, Docker bridge)
        │           └── postgres @ <databases_private_ip>:5432
        └── /*    → griddog-frontend  <frontend_private_ip>:3000  (Next.js)

Puppeteer  (griddog-traffic on griddog-frontend)
  → ALB DNS  (synthetic load through the public ALB, then back through nginx)

Backend traffic-control API
  → http://<frontend_private_ip>:3002  (start/stop Puppeteer)
```

> Same-EC2 communication uses Docker container names on the shared `griddog_network`
> bridge. Cross-EC2 communication uses private IPs templated by Ansible from
> `group_vars/all.yml`. No Route 53 lookups.

---

## Service Addressing

There are **two** addressing mechanisms, applied per call site:

### Within `griddog-app` EC2 (Docker bridge `griddog_network`)

| Caller | Target | Address |
|---|---|---|
| Go backend | Java service | `http://java-service:8081` |
| Go backend | Express service | `http://express-service:3001` |
| Go backend | .NET scheduler | `http://dotnet-scheduler:5000` |
| Datadog Agent (joins `griddog_network`) | reached by app containers via | `datadog-agent` |

### Cross-EC2 (private IPs from Ansible vars)

| Caller | Target | Address (templated) |
|---|---|---|
| Go backend | Postgres | `<databases_private_ip>:5432` |
| Go backend | Traffic control API | `<frontend_private_ip>:3002` |
| Java service | Postgres | `<databases_private_ip>:5432` |
| Express service | MongoDB | `<databases_private_ip>:27017` |
| .NET scheduler | Postgres | `<databases_private_ip>:5432` |
| Puppeteer (frontend) | ALB DNS | `<alb_dns>` |
| nginx (upstreams) | frontend / app | `<frontend_private_ip>:3000`, `<app_private_ip>:8080` |

Variable values come from [ansible/group_vars/all.yml](ansible/group_vars/all.yml) (gitignored)
and are filled in from `terraform output` after the Terraform apply.

---

## Security Groups

All five SGs are defined in [terraform/security_groups.tf](terraform/security_groups.tf).
SSH ingress on port 22 is allowed from both `admin_cidr` (direct) and `sg-nginx` (jump host)
on the three private SGs.

### sg-alb (`griddog-ec2-alb`)
| Dir | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| In | TCP | 80 | `alb_allowed_cidrs` | HTTP from allowed admin IPs |
| In | TCP | 80 | sg-frontend | Puppeteer synthetic traffic via ALB |
| In | TCP | 80 | NAT EIP /32 | Puppeteer egress through NAT, returns through ALB |
| Out | TCP | 80 | sg-nginx | Forward to nginx EC2 |

### sg-nginx (`griddog-ec2-nginx`)
| Dir | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| In | TCP | 22 | `admin_cidr` | SSH from admin |
| In | TCP | 80 | sg-alb | HTTP from ALB |
| Out | TCP | 22 | sg-frontend, sg-app, sg-databases | SSH bastion to private EC2s |
| Out | TCP | 3000 | sg-frontend | Reverse proxy upstream |
| Out | TCP | 8080 | sg-app | Reverse proxy upstream |
| Out | TCP | 80 / 443 | 0.0.0.0/0 | apt + package installs |

### sg-frontend (`griddog-ec2-frontend`)
| Dir | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| In | TCP | 22 | sg-nginx, `admin_cidr` | SSH (bastion or direct) |
| In | TCP | 3000 | sg-nginx | Next.js from nginx |
| In | TCP | 3002 | sg-app | Traffic-control API from backend |
| Out | TCP | 80 | sg-nginx, sg-alb | Puppeteer synthetic traffic |
| Out | TCP | 8080 | sg-app | Next.js server-side → Go backend |
| Out | TCP | 80 / 443 | 0.0.0.0/0 | apt + npm |

### sg-app (`griddog-ec2-app`)
| Dir | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| In | TCP | 22 | sg-nginx, `admin_cidr` | SSH (bastion or direct) |
| In | TCP | 8080 | sg-nginx, sg-frontend | Go backend ingress |
| Out | TCP | 5432 | sg-databases | PostgreSQL |
| Out | TCP | 27017 | sg-databases | MongoDB |
| Out | TCP | 3002 | sg-frontend | Traffic-control API to frontend |
| Out | TCP | 80 / 443 | 0.0.0.0/0 | apt + SSM + Docker registry |

> Ports 8081 (Java), 3001 (Express), and 5000 (.NET) are intra-EC2 only — they're
> reachable on the Docker bridge `griddog_network` and don't need SG ingress rules.

### sg-databases (`griddog-ec2-databases`)
| Dir | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| In | TCP | 22 | sg-nginx, `admin_cidr` | SSH (bastion or direct) |
| In | TCP | 5432 | sg-app | PostgreSQL from app |
| In | TCP | 27017 | sg-app | MongoDB from app |
| Out | TCP | 80 / 443 | 0.0.0.0/0 | apt + SSM |

---

## Environment Variable Configuration

Set in Ansible templates from [ansible/templates/](ansible/templates/), with values
sourced from `group_vars/all.yml`. The Datadog agent joins the `griddog_network` bridge
on the app host, which is why app containers can reach it via the container name
`datadog-agent`.

| Variable | Container (EC2) | Value |
|---|---|---|
| `JAVA_SERVICE_URL` | griddog-backend (app) | `http://java-service:8081` |
| `EXPRESS_SERVICE_URL` | griddog-backend (app) | `http://express-service:3001` |
| `DOTNET_SCHEDULER_URL` | griddog-backend (app) | `http://dotnet-scheduler:5000` |
| `TRAFFIC_SERVICE_URL` | griddog-backend (app) | `http://<frontend_private_ip>:3002` |
| `DATABASE_URL` | griddog-backend (app) | `postgres://griddog:<pwd>@<databases_private_ip>:5432/griddog?sslmode=disable` |
| `DATABASE_URL` (JDBC) | griddog-java-service (app) | `jdbc:postgresql://<databases_private_ip>:5432/griddog` |
| `MONGODB_URI` | griddog-express-service (app) | `mongodb://<databases_private_ip>:27017/griddog` |
| `DATABASE_URL` (.NET) | griddog-dotnet-scheduler (app) | `Host=<databases_private_ip>;Port=5432;Database=griddog;…` |
| `NEXT_PUBLIC_BACKEND_URL` | griddog-frontend (build-time ARG) | `http://<alb_dns>` |
| `TRAFFIC_BASE_URL` | griddog-traffic (frontend) | `http://<alb_dns>` |
| `DD_AGENT_HOST` | all app containers | `datadog-agent` (Docker bridge name) |

### Secrets

- **Provisioned in SSM Parameter Store** under `/griddog/sg/` (`db_password`, `dd_api_key` as `SecureString`)
  via [terraform/ssm.tf](terraform/ssm.tf). EC2s have an IAM instance profile granting `ssm:GetParameter` access.
- **Used by Ansible** via `group_vars/all.yml` (gitignored). SSM is available for runtime fetch
  (`aws ssm get-parameter --with-decryption`) but the current playbooks template values directly from `group_vars`.

---

## nginx Config

The EC2 nginx config is rendered from a Jinja template at deploy time:

| File | Purpose |
|---|---|
| [ansible/templates/nginx.conf.j2](ansible/templates/nginx.conf.j2) | EC2 nginx config — upstreams use private IPs (`<frontend_private_ip>`, `<app_private_ip>`) |
| `deploy/docker/nginx.conf` | Docker Compose nginx config — upstreams use Docker service names (`frontend:3000`, `backend:8080`) |

The configs are functionally identical apart from how they address upstreams.

---

## ALB and DNS

- **Listener:** HTTP :80 → forward to nginx EC2 :80 target group (no HTTPS yet — add an ACM cert + 443 listener when a domain is ready)
- **Health check:** `GET /nginx-health` on port 80 (200 expected; defined in `nginx.conf.j2`)
- **Subnets:** spans `172.31.64.0/24` (1b) and `172.31.65.0/24` (1a) — ALB requires ≥2 AZs
- **Access control:** ingress on :80 is restricted to `alb_allowed_cidrs` (your admin IPs), plus sg-frontend (Puppeteer) and the NAT EIP `/32`
- **DNS:** consumers hit the ALB DNS name directly (`griddog-alb-<id>.ap-southeast-1.elb.amazonaws.com` — see `terraform output app_url`). No Route 53 public record is provisioned.

---

## Image Build Strategy (No ECR)

Images are built **on each EC2** by Ansible during playbook runs — no shared registry.

How it works:
1. The `clone repo` task on each EC2 uses a GitHub PAT (`group_vars/all.yml: github_pat`) to clone into `/opt/griddog`.
2. Each `community.docker.docker_compose_v2` task points at a Jinja-rendered `docker-compose.<role>.yml` whose `build:` blocks reference subdirectories in the repo.
3. `docker compose up --build` builds the needed images and starts the containers.

| EC2 | Built / pulled |
|---|---|
| griddog-databases | pulls `postgres:15`, `mongo:7` (no build) |
| griddog-app | builds `backend/`, `java-service/`, `express-service/`, `dotnet-scheduler/` |
| griddog-frontend | builds `frontend/` (with `--build-arg NEXT_PUBLIC_BACKEND_URL=http://<alb_dns>`) and `traffic/` |
| griddog-nginx | pulls `nginx:alpine` (no build), config rendered from `nginx.conf.j2` |
| All four | pulls Datadog agent image |

> When you add ECR later: push tagged images and switch `build:` blocks to `image:` references in the compose templates.

---

## Deployment Sequencing

Provisioning is two phases: Terraform once, then Ansible per change.

### Phase 1 — Infra (Terraform)

```bash
cd deploy/vm/terraform
export AWS_PROFILE=griddog
terraform apply        # ~5–8 min (NAT GW + ALB are slow)
terraform output       # IPs, ALB DNS, SSH commands
```

This provisions: subnets, NAT GW, route tables, 5 SGs, 4 EC2s, 2 EBS volumes,
ALB + target group + HTTP listener, SSM params, IAM instance profile.

### Phase 2 — Application (Ansible)

Fill in `ansible/inventory.ini` (IPs from `terraform output`) and
`ansible/group_vars/all.yml` (DB password, IPs, ALB DNS, GitHub PAT). Then:

```bash
cd deploy/vm/ansible
ansible all -m ping                              # connectivity check

ansible-playbook playbooks/01_databases.yml      # postgres + mongodb (databases EC2)
ansible-playbook playbooks/02_app.yml            # backend + java + express + dotnet-scheduler (app EC2)
ansible-playbook playbooks/03_frontend.yml       # Next.js (frontend EC2)
ansible-playbook playbooks/04_nginx.yml          # nginx reverse proxy (nginx EC2)
ansible-playbook playbooks/05_traffic.yml        # Puppeteer traffic generator (frontend EC2)
ansible-playbook playbooks/06_datadog.yml        # Datadog agent (all 4 EC2s)
```

Ordering matters: `02_app` depends on databases being up; `04_nginx` depends on the
private IPs of frontend and app being reachable. `06_datadog` joins the
`griddog_network` bridge on the app host so app containers can reach it via the
container name `datadog-agent`.

### Phase 3 — Validate

```bash
ansible all -m shell -a "docker ps"              # all expected containers Up
curl http://<alb_dns>/nginx-health               # 200
curl http://<alb_dns>/health                     # 200 (proxied to Go backend)
```

Verify all 10 flow cards in the frontend UI and check APM traces span
`go-backend-vm → java-backend-vm → postgres` and `go-backend-vm → express-service-vm → mongodb`
in Datadog.

---

## EBS Layout (databases EC2 only)

| Volume | Device | Size | Mount | Purpose |
|---|---|---|---|---|
| Root | `/dev/sda1` | 20 GB gp3 | `/` | OS, Docker, repo |
| griddog-postgres-data | `/dev/xvdf` | 8 GB gp3 | `/data/postgres` | Postgres data dir |
| griddog-mongodb-data | `/dev/xvdg` | 8 GB gp3 | `/data/mongodb` | MongoDB data dir |

Data volumes are formatted, mounted, and bind-mounted into the postgres/mongo
containers by `playbooks/01_databases.yml`. They survive instance termination
unless `terraform destroy` is run.

---

## Cost Estimate (Singapore, on-demand, monthly)

| Resource | Details | USD/mo |
|---|---|---|
| 1× EC2 t3.micro | griddog-nginx | ~$9 |
| 3× EC2 t3.medium | griddog-frontend, griddog-app, griddog-databases | ~$96 |
| 1× NAT Gateway | hourly + data | ~$35 |
| 1× ALB | per LCU hour | ~$20 |
| EBS gp3 | 4× 20 GB root + 2× 8 GB data | ~$8 |
| Elastic IP (NAT) | attached, no charge while in use | ~$0 |
| **Total** | | **~$168/mo** |

> Stop the EC2s when not in use → cost drops to NAT GW + ALB + EBS storage (~$60/mo idle).
> NAT Gateway and ALB are billed hourly even when EC2s are stopped — `terraform destroy` is
> the only way to zero out infra cost.
