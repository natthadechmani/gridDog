# GridDog — Observability Sandbox

A mock multi-service web application for testing **logging**, **metrics**, and **traces** with Datadog. Includes intentional error flows, stress test endpoints, and a Datadog-themed UI for generating traffic interactively.

---

## Architecture

```
gridDog/
├── database/init.sql              # PostgreSQL schema + seed data (5 items)
├── backend/                       # Go (Gin) — port 8080
├── java-service/                  # Spring Boot 3.2 (Java 17) — port 8081
├── express-service/               # Express.js — port 3001
├── frontend/                      # Next.js 14 (App Router) — port 3000
└── deploy/
    ├── vm/                        # EC2 systemd setup scripts
    ├── docker/                    # docker-compose (base + regional overrides)
    └── kubernetes/                # Kustomize base + Thailand/Singapore overlays
```

---

## API Flows

| # | Flow | Endpoint | Expected |
|---|------|----------|----------|
| 1 | GET correct path | `GET /api/flow/1` | Go → Java → DB (id=1) → 200 |
| 2 | GET DB not found | `GET /api/flow/2` | Go → Java → DB (id=9999) → 404 error |
| 3a | GET compute success | `GET /api/flow/3/success` | Go → Express → fibonacci → 200 |
| 3b | GET compute timeout | `GET /api/flow/3/timeout` | Go → Express (15s sleep) → 504 timeout |
| 4 | POST create item | `POST /api/flow/4` | Go → Java → DB insert → 201 |
| 5 | GET cascade failure | `GET /api/flow/cascade` | Java fails → Express skipped → 206 partial |
| 6 | CPU stress toggle | `GET /api/stress/cpu` | Goroutines running sqrt loops |
| 7 | Memory stress toggle | `GET /api/stress/memory` | 100MB allocations held in memory |
| 8 | DB stress toggle | `GET /api/stress/db` | Rapid SELECT bursts on the DB |

Stress endpoints toggle on/off each call. `GET /api/stress/status` returns current state of all three.

---

## Logging

| Service | Library | Format |
|---------|---------|--------|
| Go backend | `log/slog` | Structured JSON, `request_id` (UUID) on every log line |
| Java service | Logback + LogstashEncoder | JSON with `service=java-service` field |
| Express service | Winston | JSON with `service=express-service` field |

All outbound calls log: target service, endpoint, duration, and status code.

---

## Frontend UI

Datadog-themed dark dashboard (`#0F1117` background, `#7B4FFF` purple accent):

- **Navbar** — Dog logo, live clock, service health dots (polls every 10s)
- **API Flow Tests** — 7 test cards, each with Send button, JSON response viewer, status code, and latency
- **Stress Controls** — Toggle switches for CPU / Memory / DB stress
- **Traffic Generator** — Configurable flow, batch size, and interval with live sent/success/error counters
- **Response Log** — Terminal-style scrollable log of last 50 requests, color-coded by HTTP status

---

## Deployment

### 1. VM (EC2)

Deploy each service on a separate EC2 instance. Designed for **Thailand (ap-southeast-7)** and **Singapore (ap-southeast-1)**, each with 2 AZs.

**Recommended instance types:** `t3.small` for Go/Express/Frontend, `t3.medium` for Java, `t3.small` for PostgreSQL.

Run in order on each node:

```bash
# All nodes
sudo bash deploy/vm/setup-common.sh

# PostgreSQL node
sudo bash deploy/vm/setup-postgres.sh

# Backend node
sudo JAVA_SERVICE_URL=http://<java-ip>:8081 \
     EXPRESS_SERVICE_URL=http://<express-ip>:3001 \
     DATABASE_URL=postgres://griddog:griddog@<db-ip>:5432/griddog \
     bash deploy/vm/setup-backend.sh

# Java node
sudo DATABASE_URL=jdbc:postgresql://<db-ip>:5432/griddog \
     bash deploy/vm/setup-java.sh

# Express node
sudo bash deploy/vm/setup-express.sh

# Frontend node
sudo NEXT_PUBLIC_BACKEND_URL=http://<backend-ip>:8080 \
     bash deploy/vm/setup-frontend.sh
```

See [deploy/vm/architecture.md](deploy/vm/architecture.md) for full EC2 layout, VPC CIDRs, and security group rules per region.

---

### 2. Docker Compose

```bash
# Build all images
docker build -t griddog/backend       ./backend
docker build -t griddog/java-service  ./java-service
docker build -t griddog/express-service ./express-service
docker build -t griddog/frontend      ./frontend

# Run locally
docker compose -f deploy/docker/docker-compose.yml up -d

# Thailand (ap-southeast-7)
docker compose -f deploy/docker/docker-compose.yml \
               -f deploy/docker/docker-compose.thailand.yml up -d

# Singapore (ap-southeast-1)
docker compose -f deploy/docker/docker-compose.yml \
               -f deploy/docker/docker-compose.singapore.yml up -d
```

Services and ports:

| Service | Port |
|---------|------|
| Frontend | 3000 |
| Backend | 8080 |
| Java service | 8081 |
| Express service | 3001 |
| PostgreSQL | 5432 |

---

### 3. Kubernetes

Uses Kustomize with a shared base and per-region overlays.

```bash
# Base (local/dev)
kubectl apply -k deploy/kubernetes/base

# Thailand overlay (namePrefix: th-, region: ap-southeast-7, az: ap-southeast-7a)
kubectl apply -k deploy/kubernetes/overlays/thailand

# Singapore overlay (namePrefix: sg-, region: ap-southeast-1, az: ap-southeast-1b)
kubectl apply -k deploy/kubernetes/overlays/singapore
```

Includes: Namespace, ConfigMap, StatefulSet for Postgres, Deployments + Services for all 4 app services, and an HPA for the backend (min 2 / max 6 pods at 70% CPU).

Regional overlays reduce replicas to 1 per Deployment for cost savings and patch the `REGION` config value.

---

## Environment Variables

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `PORT` | All | varies | HTTP listen port |
| `JAVA_SERVICE_URL` | Backend | `http://localhost:8081` | Java microservice base URL |
| `EXPRESS_SERVICE_URL` | Backend | `http://localhost:3001` | Express microservice base URL |
| `DATABASE_URL` | Backend | `postgres://griddog:griddog@localhost:5432/griddog` | PostgreSQL connection string (Go format) |
| `DATABASE_URL` | Java | `jdbc:postgresql://localhost:5432/griddog` | PostgreSQL connection string (JDBC format) |
| `DB_USER` | Java | `griddog` | Database username |
| `DB_PASSWORD` | Java | `griddog` | Database password |
| `NEXT_PUBLIC_BACKEND_URL` | Frontend | `http://localhost:8080` | Backend URL (baked in at build time) |
