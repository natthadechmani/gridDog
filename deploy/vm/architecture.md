# GridDog — AWS EC2 Deployment Architecture (Singapore)

## Overview

GridDog runs in **Singapore (ap-southeast-1)** on **4 EC2 instances** in a single VPC,
each running Docker containers via systemd unit files. All services share a Route 53
private hosted zone (`griddog.internal`) for stable DNS-based service discovery.

---

## EC2 Fleet

| EC2 Name | Services | Instance Type | Subnet |
|---|---|---|---|
| `griddog-nginx` | nginx reverse proxy (:80) | t3.micro | Public `10.1.1.0/24` |
| `griddog-frontend` | Next.js (:3000) + Puppeteer traffic bot (:3002) | t3.micro | Private `10.1.2.0/24` |
| `griddog-app` | Go/Gin (:8080) + Spring Boot (:8081) + Express.js (:3001) | t3.small | Private `10.1.2.0/24` |
| `griddog-databases` | PostgreSQL 15 (:5432) + MongoDB 7 (:27017) | t3.small | Private `10.1.2.0/24` |

---

## VPC and Subnet Setup

| Resource | Value |
|---|---|
| VPC name | griddog-sg-vpc |
| VPC CIDR | 10.1.0.0/16 |
| Public subnet | 10.1.1.0/24 (ap-southeast-1b) |
| Private subnet | 10.1.2.0/24 (ap-southeast-1b) |
| Internet Gateway | igw-sg-griddog |
| NAT Gateway | ngw-sg-griddog (in public subnet, serves private subnet) |
| ALB | In public subnet, HTTPS:443 → nginx EC2:80 |

```
VPC: griddog-sg-vpc  |  CIDR: 10.1.0.0/16
│
├── Public Subnet: 10.1.1.0/24  (ap-southeast-1b)
│   ├── Internet Gateway (igw-sg-griddog)
│   ├── NAT Gateway + Elastic IP (ngw-sg-griddog)
│   ├── Application Load Balancer
│   └── EC2: griddog-nginx
│
└── Private Subnet: 10.1.2.0/24  (ap-southeast-1b)
    ├── EC2: griddog-frontend   (Next.js :3000 + Puppeteer :3002)
    ├── EC2: griddog-app        (Go :8080 + Spring Boot :8081 + Express :3001)
    └── EC2: griddog-databases  (Postgres :5432 + MongoDB :27017)
```

---

## Request Flow

```
Browser
  → app.sg.griddog.example.com (Route 53 public)
    → ALB :443 (HTTPS, ACM cert)
      → griddog-nginx :80
        ├── /api/* → backend.griddog.internal:8080  (griddog-app)
        │     ├── localhost:8081  (java-service, same EC2)
        │     │     └── postgres.griddog.internal:5432
        │     └── localhost:3001  (express-service, same EC2)
        │           └── mongodb.griddog.internal:27017
        └── /*    → frontend.griddog.internal:3000  (griddog-frontend)

Puppeteer (griddog-frontend) → nginx.griddog.internal:80 (synthetic load)
```

> Go backend, Spring Boot, and Express share `griddog-app` and communicate via
> `localhost` using `--network=host`. No cross-EC2 traffic for those ports.

---

## Service Discovery (Route 53 Private Hosted Zone: `griddog.internal`)

| DNS Record | EC2 | Port | Used By |
|---|---|---|---|
| `nginx.griddog.internal` | griddog-nginx | 80 | Puppeteer TRAFFIC_BASE_URL |
| `frontend.griddog.internal` | griddog-frontend | 3000 | nginx upstream |
| `backend.griddog.internal` | griddog-app | 8080 | nginx upstream, Next.js server |
| `java-service.griddog.internal` | griddog-app | 8081 | (external reference only; Go uses localhost) |
| `express-service.griddog.internal` | griddog-app | 3001 | (external reference only; Go uses localhost) |
| `postgres.griddog.internal` | griddog-databases | 5432 | Go backend, Spring Boot |
| `mongodb.griddog.internal` | griddog-databases | 27017 | Express.js |

---

## Security Groups

### sg-alb
| Dir | Protocol | Port | Source |
|---|---|---|---|
| In | TCP | 80 | 0.0.0.0/0 (redirect → 443) |
| In | TCP | 443 | 0.0.0.0/0 |
| Out | TCP | 80 | sg-nginx |

### sg-nginx
| Dir | Protocol | Port | Source |
|---|---|---|---|
| In | TCP | 22 | Admin CIDR |
| In | TCP | 80 | sg-alb |
| Out | TCP | 3000 | sg-frontend |
| Out | TCP | 8080 | sg-app |
| Out | TCP | 443 | 0.0.0.0/0 |

### sg-frontend
| Dir | Protocol | Port | Source |
|---|---|---|---|
| In | TCP | 22 | Admin CIDR |
| In | TCP | 3000 | sg-nginx |
| Out | TCP | 80 | sg-nginx (Puppeteer synthetic traffic) |
| Out | TCP | 8080 | sg-app (Next.js server → backend) |
| Out | TCP | 443 | 0.0.0.0/0 |

### sg-app
| Dir | Protocol | Port | Source |
|---|---|---|---|
| In | TCP | 22 | Admin CIDR |
| In | TCP | 8080 | sg-nginx, sg-frontend (Go backend) |
| Out | TCP | 5432 | sg-databases |
| Out | TCP | 27017 | sg-databases |
| Out | TCP | 443 | 0.0.0.0/0 |

> Ports 8081 (Java) and 3001 (Express) are internal to the EC2 — no inbound SG rules needed.

### sg-databases
| Dir | Protocol | Port | Source |
|---|---|---|---|
| In | TCP | 22 | Admin CIDR |
| In | TCP | 5432 | sg-app |
| In | TCP | 27017 | sg-app |
| Out | TCP | 443 | 0.0.0.0/0 |

---

## Environment Variable Configuration

| Variable | EC2 | Value |
|---|---|---|
| `JAVA_SERVICE_URL` | griddog-app (backend) | `http://localhost:8081` |
| `EXPRESS_SERVICE_URL` | griddog-app (backend) | `http://localhost:3001` |
| `DATABASE_URL` | griddog-app (backend) | `postgres://griddog:<pwd>@postgres.griddog.internal:5432/griddog?sslmode=disable` |
| `SPRING_DATASOURCE_URL` | griddog-app (java) | `jdbc:postgresql://postgres.griddog.internal:5432/griddog` |
| `MONGODB_URI` | griddog-app (express) | `mongodb://griddog:<pwd>@mongodb.griddog.internal:27017/griddog?authSource=admin` |
| `NEXT_PUBLIC_BACKEND_URL` | griddog-frontend (build-time ARG) | `https://app.sg.griddog.example.com` |
| `TRAFFIC_BASE_URL` | griddog-frontend (puppeteer) | `http://nginx.griddog.internal` |

All secrets stored in **SSM Parameter Store** under `/griddog/sg/` and injected at
container start via `aws ssm get-parameter --with-decryption`.

---

## nginx Config

For EC2 deployment use `deploy/ec2/nginx.conf` (Route 53 DNS upstreams).
For Docker Compose use `deploy/docker/nginx.conf` (Docker service name upstreams).

The only difference is the upstream server addresses:

| Config file | frontend upstream | backend upstream |
|---|---|---|
| `deploy/docker/nginx.conf` | `frontend:3000` | `backend:8080` |
| `deploy/ec2/nginx.conf` | `frontend.griddog.internal:3000` | `backend.griddog.internal:8080` |

---

## ALB and DNS

- **ALB listeners:** HTTP:80 → redirect HTTPS; HTTPS:443 → forward to `griddog-nginx` EC2 port 80
- **Health check:** `GET /nginx-health` on port 80 (returns 200, defined in nginx.conf)
- **ACM cert:** `*.griddog.example.com` in ap-southeast-1, DNS validated
- **Public DNS:** `app.sg.griddog.example.com` ALIAS → ALB DNS name

---

## Image Build Strategy (No ECR)

For a testing environment, build Docker images directly on each EC2 from the repo.
No ECR needed.

```bash
# On each EC2 after bootstrap:
git clone <your-repo-url> /opt/griddog
cd /opt/griddog

# Build only the image(s) needed on this EC2:
# griddog-app:
docker build -t griddog/backend    ./backend
docker build -t griddog/java-service ./java-service
docker build -t griddog/express-service ./express-service

# griddog-frontend:
docker build \
  --build-arg NEXT_PUBLIC_BACKEND_URL="http://<nginx-ec2-public-ip>" \
  -t griddog/frontend ./frontend
docker build -t griddog/traffic ./traffic

# griddog-nginx: uses nginx:alpine directly (no custom build needed)
# griddog-databases: uses postgres:15 and mongo:7 directly (no custom build needed)
```

> When you add ECR later: push images there and update the `docker run` commands to
> reference `<account>.dkr.ecr.ap-southeast-1.amazonaws.com/griddog/<service>:latest`.

---

## Deployment Sequencing

```
Phase 1 — Foundation
  1. VPC, subnets, IGW, NAT GW, route tables, security groups
  2. Route 53 private zone griddog.internal
  3. Set SSM parameter values (DB passwords, DD API key, backend URL)

Phase 2 — Databases (griddog-databases, t3.small)
  4. Attach 2× 8 GB gp3 EBS volumes → mount at /data/postgres, /data/mongodb
  5. git clone repo → no build needed (uses official postgres:15 + mongo:7 images)
  6. Start postgres container → verify init.sql seeded
  7. Start mongodb container (with MONGO_INITDB_ROOT_* auth)
  8. Set Route 53 A records: postgres.griddog.internal + mongodb.griddog.internal

Phase 3 — App Services (griddog-app, t3.small, --network=host)
  9. git clone repo → docker build backend, java-service, express-service
  10. Start java-service → verify GET /actuator/health → {"status":"UP"}
  11. Start express-service → verify GET /health → 200
  12. Start backend (Go) → verify GET /health → 200
  13. Set Route 53 A records: backend / java-service / express-service .griddog.internal

Phase 4 — Frontend + Traffic (griddog-frontend, t3.micro)
  14. git clone repo → docker build frontend (with NEXT_PUBLIC_BACKEND_URL) + traffic
  15. Start frontend container → verify Next.js at :3000
  16. Start traffic (Puppeteer) with --shm-size=2g
  17. Set Route 53 A records: frontend.griddog.internal + nginx.griddog.internal

Phase 5 — Entry Point (griddog-nginx, t3.micro, public subnet)
  18. Copy deploy/ec2/nginx.conf to /opt/griddog/nginx.conf on nginx EC2
  19. docker run nginx:alpine with mounted config
  20. Verify GET /nginx-health → 200
  21. Create ALB → target group → HTTPS listener + ACM cert
  22. Set public Route 53: app.sg.griddog.example.com → ALB ALIAS

Phase 6 — Observability
  23. Start Datadog Agent container on all 4 EC2s
  24. Verify logs + APM traces in Datadog

Phase 7 — Validation
  25. curl https://app.sg.griddog.example.com/health → {"status":"ok"}
  26. Verify all 10 flow cards load in the frontend UI
  27. Verify APM traces span Go → Java → Postgres and Go → Express → MongoDB
```

---

## Cost Estimate (Singapore, on-demand, monthly)

| Resource | Details | USD/mo |
|---|---|---|
| 2× EC2 t3.micro | griddog-nginx, griddog-frontend | ~$19 |
| 2× EC2 t3.small | griddog-app, griddog-databases | ~$37 |
| 1× NAT Gateway | hourly + data | ~$35 |
| 1× ALB | per LCU hour | ~$20 |
| EBS gp3 ~50 GB | 4× 8 GB root + 2× 5 GB data volumes | ~$4 |
| Route 53 | private + public zones | ~$1 |
| **Total** | | **~$116/mo** |

> Stop instances when not in use → cost drops to just EBS storage (~$4/mo idle).
