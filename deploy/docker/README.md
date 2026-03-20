# GridDog – Docker Compose Deployment

This directory contains Docker Compose files for running the full GridDog stack
locally and in AWS regional deployments.

---

## Project Services

| Service          | Image                       | Port |
|------------------|-----------------------------|------|
| frontend         | griddog/frontend            | 3000 |
| backend          | griddog/backend             | 8080 |
| java-service     | griddog/java-service        | 8081 |
| express-service  | griddog/express-service     | 3001 |
| postgres         | postgres:15                 | 5432 |

---

## Prerequisites

- Docker >= 24
- Docker Compose >= 2.20 (the `docker compose` plugin or `docker-compose` v2)

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
docker-compose up -d
```

To view logs for all services:

```bash
docker-compose logs -f
```

To tear down the stack (volumes are preserved):

```bash
docker-compose down
```

To tear down the stack and remove the postgres data volume:

```bash
docker-compose down -v
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
docker-compose -f docker-compose.yml -f docker-compose.thailand.yml up -d
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
docker-compose -f docker-compose.yml -f docker-compose.singapore.yml up -d
```

---

## Compose File Reference

| File                          | Purpose                                      |
|-------------------------------|----------------------------------------------|
| `docker-compose.yml`          | Base file – all services, healthchecks, resource limits |
| `docker-compose.thailand.yml` | Override – Thailand region (ap-southeast-7)  |
| `docker-compose.singapore.yml`| Override – Singapore region (ap-southeast-1) |

Regional override files only re-declare fields that differ from the base:
image tags and labels. All environment variables, port bindings, healthchecks,
and resource limits are inherited from `docker-compose.yml`.

---

## Healthchecks

| Service         | Endpoint checked                        |
|-----------------|-----------------------------------------|
| postgres        | `pg_isready -U griddog -d griddog`      |
| backend         | `GET /health`                           |
| java-service    | `GET /actuator/health`                  |
| express-service | `GET /health`                           |
| frontend        | `GET /` (HTTP 200)                      |

`backend`, `java-service`, and `express-service` wait for postgres to report
`healthy` before starting. `frontend` waits for `backend` to be healthy.

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
