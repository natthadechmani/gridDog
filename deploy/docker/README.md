# GridDog – Docker Compose Deployment

This directory contains Docker Compose files for running the full GridDog stack
locally and in AWS regional deployments.

---

## Project Services

| Service          | Image                       | Internal Port | Public Port |
|------------------|-----------------------------|---------------|-------------|
| nginx            | nginx:alpine                | 80            | **80**      |
| frontend         | griddog/frontend            | 3000          | —           |
| backend          | griddog/backend             | 8080          | —           |
| java-service     | griddog/java-service        | 8081          | 8081        |
| express-service  | griddog/express-service     | 3001          | 3001        |
| postgres         | postgres:15                 | 5432          | 5432        |

nginx is the single entry point on port 80. The frontend is not exposed directly.

---

## Prerequisites

- Docker >= 24
- Docker Compose >= 2.20 (the `docker compose` plugin or `docker-compose` v2)

---

## Configuration

### Frontend public URL

The frontend makes API calls from the browser, so `NEXT_PUBLIC_BACKEND_URL` must
be set to the host that nginx is reachable on. This value is baked into the
Next.js bundle at **build time** — changing it requires a rebuild.

| Environment   | Value                              |
|---------------|------------------------------------|
| Local         | `http://localhost`                 |
| EC2           | `http://<your-ec2-public-ip-or-dns>` |

Edit the `frontend.build.args` and `frontend.environment` fields in
`docker-compose.yml` before building.

---

## Build All Images

Run these commands from the repository root before deploying.

```bash
# Frontend – Next.js
docker build -t griddog/frontend:latest ./frontend

# Backend – Golang
docker build -t griddog/backend:latest ./backend

# Java Service – Spring Boot
docker build -t griddog/java-service:latest ./java-service

# Express Service – Express.js
docker build -t griddog/express-service:latest ./express-service
```

---

## Running the Stack

### Local development

Uses the base compose file only. Images are tagged `latest`.

```bash
# From this directory (deploy/docker)
docker compose up --build
```

To view logs for all services:

```bash
docker compose logs -f
```

To tear down the stack (volumes are preserved):

```bash
docker compose down
```

To tear down the stack and remove the postgres data volume:

```bash
docker compose down -v
```

---

### Thailand – ap-southeast-7 (Bangkok)

Runs on a single EC2 instance in availability zone `ap-southeast-7a`.
Images are tagged `latest-ap-southeast-7`.

Build region-tagged images before deploying:

```bash
docker build -t griddog/frontend:latest-ap-southeast-7 ./frontend
docker build -t griddog/backend:latest-ap-southeast-7 ./backend
docker build -t griddog/java-service:latest-ap-southeast-7 ./java-service
docker build -t griddog/express-service:latest-ap-southeast-7 ./express-service
```

Deploy:

```bash
docker compose -f docker-compose.yml -f docker-compose.thailand.yml up -d
```

---

### Singapore – ap-southeast-1

Runs on a single EC2 instance in availability zone `ap-southeast-1b`.
Images are tagged `latest-ap-southeast-1`.

Build region-tagged images before deploying:

```bash
docker build -t griddog/frontend:latest-ap-southeast-1 ./frontend
docker build -t griddog/backend:latest-ap-southeast-1 ./backend
docker build -t griddog/java-service:latest-ap-southeast-1 ./java-service
docker build -t griddog/express-service:latest-ap-southeast-1 ./express-service
```

Deploy:

```bash
docker compose -f docker-compose.yml -f docker-compose.singapore.yml up -d
```

---

## Compose File Reference

| File                          | Purpose                                      |
|-------------------------------|----------------------------------------------|
| `docker-compose.yml`          | Base file – all services, healthchecks, resource limits |
| `docker-compose.thailand.yml` | Override – Thailand region (ap-southeast-7)  |
| `docker-compose.singapore.yml`| Override – Singapore region (ap-southeast-1) |
| `nginx.conf`                  | nginx reverse proxy config (port 80 entry point) |

Regional override files only re-declare fields that differ from the base:
image tags and labels. All environment variables, port bindings, healthchecks,
and resource limits are inherited from `docker-compose.yml`.

---

## nginx Routing

nginx listens on port 80 and routes traffic as follows:

| Path prefix | Proxied to        |
|-------------|-------------------|
| `/api/`     | `backend:8080`    |
| `/health`   | `backend:8080`    |
| `/`         | `frontend:3000`   |

---

## Healthchecks

Healthchecks drive the startup dependency chain. Services will not start until
their dependencies report healthy.

| Service         | Endpoint checked                        | Method        | Interval |
|-----------------|-----------------------------------------|---------------|----------|
| postgres        | `pg_isready -U griddog -d griddog`      | pg_isready    | 5m       |
| backend         | `GET /health`                           | wget          | 5m       |
| java-service    | `GET /actuator/health`                  | wget          | 5m       |
| express-service | `GET /health`                           | wget          | 5m       |
| frontend        | `GET /` (HTTP 200)                      | node http.get | 5m       |

**Startup order:**
```
postgres healthy → backend + java-service + express-service start
backend healthy  → frontend starts
frontend healthy → nginx starts (port 80 opens)
```

> The frontend healthcheck uses `node` instead of `wget` because the runner
> image (`node:20-alpine`) does not include `wget`.

**Health check logs are suppressed** for all services — `/health` requests are
filtered out at the logging middleware level so they do not pollute the log stream.

---

## API Flows

All flows are accessible from the frontend dashboard at `http://localhost` (or your EC2 IP).
The backend exposes them under `/api/`.

### Flow 1 — Correct Path
`GET /api/flow/1`
```
Browser → nginx :80
       → Go backend :8080  GET /api/flow/1
       → Java service :8081  GET /items/1
       → Postgres  SELECT * WHERE id=1
       ← 200 OK  item data returned up the chain
```

### Flow 2 — DB Not Found
`GET /api/flow/2`
```
Browser → nginx :80
       → Go backend :8080  GET /api/flow/2
       → Java service :8081  GET /items/9999
       → Postgres  SELECT * WHERE id=9999  (no row)
       ← Java 404 Not Found
       ← Go propagates 404 to client
```

### Flow 3 — Compute Success
`GET /api/flow/3/success`
```
Browser → nginx :80
       → Go backend :8080  GET /api/flow/3/success
       → Express service :3001  GET /compute
          Express computes fibonacci(30) in-process
       ← 200 OK  { result, computeTime }
       ← Go propagates 200 to client
```

### Flow 3 — Compute Timeout
`GET /api/flow/3/timeout`
```
Browser → nginx :80
       → Go backend :8080  GET /api/flow/3/timeout  (60s client timeout)
       → Express service :3001  GET /compute/timeout
          Express sleeps 15 000ms intentionally
       ← Express responds at ~15s
       ← Go propagates Express response to client
```
> Go gives Express up to 60s so Express always wins the race and the 15s response is returned intact.

### Flow 4 — Create Item
`POST /api/flow/4`
```
Browser → nginx :80
       → Go backend :8080  POST /api/flow/4
          Go generates random { value, created_at } payload
       → Java service :8081  POST /items  (JSON body)
       → Postgres  INSERT INTO items
       ← Java 201 Created  new entity with generated id
       ← Go returns entity to client
```

### Flow 5 — Cascade Failure
`GET /api/flow/cascade`
```
Browser → nginx :80
       → Go backend :8080  GET /api/flow/cascade

Step 1: → Java service :8081  GET /items/1
        ← if Java fails → Go skips Express, returns 206 Partial with error detail

Step 2 (only if Java succeeded):
        → Express service :3001  GET /compute
        ← 200 OK  { java: <item>, express: { status, body } }
```

### Flow 6 — Items List
`GET /api/items`
```
Browser → nginx :80
       → Go backend :8080  GET /api/items
       → Java service :8081  GET /items
       → Postgres  SELECT * FROM items
       ← Java 200 OK  [ array of all items ]
       ← Go proxies list to client
```

### Flow 7 — Flaky Error *(distributed trace target)*
`GET /api/error/flaky`
```
Browser → nginx :80
       → Go backend :8080  GET /api/error/flaky
       → Java service :8081  GET /error/flaky
          Java rolls 50/50 per request:
            50% → 500 Internal Server Error  (error log in Java)
            50% → 200 OK
       ← Go propagates Java's status and body unchanged
```

### Flow 8 — Chaos Error *(distributed trace target)*
`GET /api/error/chaos`
```
Browser → nginx :80
       → Go backend :8080  GET /api/error/chaos
       → Express service :3001  GET /error/chaos
          Express randomly picks from pool [200, 200, 429, 500, 503]:
            200 → ok
            429 → rate limit exceeded  (error log in Express)
            500 → internal server error  (error log in Express)
            503 → service unavailable  (error log in Express)
       ← Go propagates Express's status and body unchanged
```

### Flow 9 — Slow Fail *(distributed trace target)*
`GET /api/error/slow-fail`
```
Browser → nginx :80
       → Go backend :8080  GET /api/error/slow-fail
       → Express service :3001  GET /error/slow-fail
          Express sleeps 300–1500ms (random each call)
          then rolls:
            40% → 500 Internal Server Error  (error log in Express)
            60% → 200 OK
       ← Go propagates Express's status, body, and delay_ms unchanged
```

> **Flows 7–9 are designed for distributed tracing.** Errors and delays originate
> inside the downstream service (Java or Express), not in the Go backend. The Go
> backend only proxies the response through, so a trace will show exactly which
> service introduced the failure.

---

## Resource Limits

| Service         | CPU limit | Memory limit |
|-----------------|-----------|--------------|
| backend         | 0.5       | 512 MB       |
| java-service    | 1.0       | 768 MB       |
| express-service | 0.5       | 256 MB       |
| frontend        | 0.5       | 256 MB       |

Resource limits are defined under the `deploy.resources.limits` key in
`docker-compose.yml` and are honoured by Docker in standalone mode when using
Compose v2.

---

## Network

All services are attached to the `griddog` bridge network. Service names are
used as hostnames for inter-service communication (e.g. `http://java-service:8081`).

---

## Volumes

| Volume          | Mounted in                          | Purpose              |
|-----------------|-------------------------------------|----------------------|
| `postgres_data` | `/var/lib/postgresql/data`          | Persistent DB data   |
| `./../../database/init.sql` | `/docker-entrypoint-initdb.d/init.sql` | DB initialisation script |
