# GridDog — Observability Sandbox

A mock multi-service web application for testing **logging**, **metrics**, and **traces** with Datadog. Includes intentional error flows, stress test endpoints, and a Datadog-themed UI for generating traffic interactively.

---

## Architecture

```
gridDog/
├── database/init.sql              # PostgreSQL schema + seed data (items, promo_codes)
├── backend/                       # Go (Gin) — port 8080
├── java-service/                  # Spring Boot 3.2 (Java 17) — port 8081
├── express-service/               # Express.js — port 3001 (MongoDB-backed shop items)
├── frontend/                      # Next.js 14 (App Router) — port 3000
├── traffic/                       # Puppeteer headless-Chrome traffic generator
└── deploy/
    ├── vm/                        # EC2 systemd setup scripts
    ├── docker/                    # docker-compose (base + regional overrides)
    └── kubernetes/                # Kustomize base + Thailand/Singapore overlays
```

---

## API Flows

| # | Flow | Endpoint | Chain |
|---|------|----------|-------|
| 1 | GET correct path | `GET /api/flow/1` | Go → Java → Postgres (id=1) → 200 |
| 2 | GET DB not found | `GET /api/flow/2` | Go → Java → Postgres (id=9999) → 404 |
| 3a | Compute success | `GET /api/flow/3/success` | Go → Express fibonacci(30) → 200 |
| 3b | Compute timeout | `GET /api/flow/3/timeout` | Go → Express 15s sleep → response at ~15s |
| 4 | POST create item | `POST /api/flow/4` | Go → Java → Postgres INSERT → 201 |
| 5 | Cascade failure | `GET /api/flow/cascade` | Go → Java (may fail) → Express compute → 200/206 |
| 6 | Items list | `GET /api/items` | Go → Java → Postgres SELECT all → 200 |
| 7 | Flaky error | `GET /api/error/flaky` | Go → Java (50% 500) → propagated |
| 8 | Chaos error | `GET /api/error/chaos` | Go → Express (200/429/500/503 random) → propagated |
| 9 | Slow fail | `GET /api/error/slow-fail` | Go → Express (300–1500ms delay, 40% 500) → propagated |
| 10 | E-commerce shop | `/shop → /cart → /checkout` | Full browser funnel — see below |

### Flow 10 — E-Commerce Shop

**Shop items:** `GET /api/shop/items` — Go → Express → MongoDB `shop_items` collection (seeded on first start)

**Promo verify:** `GET /api/flow/10/promo/:code` — Go → Java → Postgres `promo_codes`
Valid codes: `10OFF` (10%), `15OFF` (15%), `20OFF` (20%), `50OFF` (50%)

**Checkout:** `POST /api/flow/10/checkout` — Go returns intentional 500 (payment gateway simulation)

---

## Logging

| Service | Library | Format |
|---------|---------|--------|
| Go backend | `log/slog` | Structured JSON, `request_id` (UUID) on every log line |
| Java service | Logback + LogstashEncoder | JSON with `service=java-service` field |
| Express service | Winston | JSON with `service=express-service` field |

Every route logs a descriptive `msg` string of the form `METHOD /path — what happened` (e.g. `"flow4: item inserted into postgres"`, `"GET /shop/items — fetched 6 item(s) from mongodb"`) plus structured fields for filtering (item IDs, compute results, durations, HTTP status codes). Success paths log at INFO, expected failures (invalid promo, 404 propagation) at WARN, unexpected errors at ERROR.

---

## Frontend UI

Datadog-themed dark dashboard (`#0F1117` background, `#7B4FFF` purple accent):

- **Navbar** — Dog logo, live clock, service health dots (polls every 10s)
- **API Flow Tests** — 10 flow cards (Flows 1–10), each with Send button, JSON response viewer, status code, and latency. Flow 10 navigates to `/shop`.
- **Response Log** — Terminal-style scrollable log of last 50 requests, color-coded by HTTP status
- **Puppeteer Bot status** — shows whether the headless traffic generator container is running
- **Shop** (`/shop`) — 6-item catalogue fetched via Go → Express → MongoDB
- **Cart** (`/cart`) — review items stored in `localStorage`, proceed to checkout
- **Checkout** (`/checkout`) — promo code input (Go → Java → Postgres), Place Order (always 500)

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
cd deploy/docker

# Default stack (nginx, frontend, backend, java-service, express-service, postgres, mongodb)
docker compose --profile default up --build

# Default stack + Datadog agent
docker compose --profile default --profile observability up --build

# Default stack + Puppeteer traffic generator
docker compose --profile default --profile traffic up --build

# Start traffic generator against an already-running stack
docker compose --profile traffic up traffic --build

# Tear down (volumes preserved)
docker compose --profile default down

# Tear down + reset all data volumes (postgres + mongodb)
docker compose --profile default down -v
```

Services and ports:

| Service | Port | Profile |
|---------|------|---------|
| nginx (entry point) | **80** | default |
| Frontend | — | default |
| Backend (Go) | — | default |
| Java service | 8081 | default |
| Express service | 3001 | default |
| PostgreSQL | 5432 | default |
| MongoDB | 27017 | default |
| Traffic (Puppeteer) | — | traffic |
| Datadog Agent | — | observability |

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
| `MONGODB_URI` | Express | `mongodb://localhost:27017/griddog` | MongoDB connection string |
| `NEXT_PUBLIC_BACKEND_URL` | Frontend | `http://localhost:8080` | Backend URL (baked in at build time) |
| `TRAFFIC_BASE_URL` | Traffic | `http://nginx` | Base URL for Puppeteer page visits |
