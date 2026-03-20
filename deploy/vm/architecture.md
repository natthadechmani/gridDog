# GridDog — Multi-Region VM Architecture

## Overview

GridDog is deployed across two AWS regions:

| Region | Code | Availability Zone used |
|---|---|---|
| Thailand | ap-southeast-7 | ap-southeast-7a |
| Singapore | ap-southeast-1 | ap-southeast-1b |

Each region runs a set of EC2 instances inside a dedicated VPC. The services are
separated onto dedicated instances to allow independent scaling and security
group enforcement.

---

## Per-Region EC2 Layout

```
Region VPC (10.x.0.0/16)
│
├── Public Subnet  (10.x.1.0/24)  — ap-southeast-Xa
│   └── EC2: frontend + backend   (t3.small)
│
└── Private Subnet (10.x.2.0/24)  — ap-southeast-Xa
    ├── EC2: java-service          (t3.medium)
    ├── EC2: express-service       (t3.small)
    └── EC2: PostgreSQL            (t3.small  or  RDS db.t3.micro)
```

### Instance Recommendations

| Instance | Service(s) | Recommended Type | Notes |
|---|---|---|---|
| frontend-backend | Next.js (3000) + Go backend (8080) | t3.small | Stateless; scale horizontally behind ALB |
| java-service | Spring Boot (8081) | t3.medium | JVM needs ≥ 1 GiB RAM |
| express-service | Express.js (3001) | t3.small | Low memory footprint |
| postgres | PostgreSQL 15 (5432) | t3.small (EC2) or db.t3.micro (RDS) | Use RDS for managed backups in production |

---

## VPC and Subnet Setup

### Thailand (ap-southeast-7)

| Resource | Value |
|---|---|
| VPC CIDR | 10.7.0.0/16 |
| Public subnet | 10.7.1.0/24 (ap-southeast-7a) |
| Private subnet | 10.7.2.0/24 (ap-southeast-7a) |
| Internet Gateway | igw-th-griddog |
| NAT Gateway | ngw-th-griddog (in public subnet, used by private subnet) |

### Singapore (ap-southeast-1)

| Resource | Value |
|---|---|
| VPC CIDR | 10.1.0.0/16 |
| Public subnet | 10.1.1.0/24 (ap-southeast-1b) |
| Private subnet | 10.1.2.0/24 (ap-southeast-1b) |
| Internet Gateway | igw-sg-griddog |
| NAT Gateway | ngw-sg-griddog (in public subnet, used by private subnet) |

---

## Security Group Rules

### sg-frontend-backend (attached to frontend+backend EC2)

| Direction | Protocol | Port | Source/Destination | Purpose |
|---|---|---|---|---|
| Inbound | TCP | 22 | Your admin CIDR | SSH |
| Inbound | TCP | 80 / 443 | 0.0.0.0/0 | ALB or direct browser access |
| Inbound | TCP | 3000 | ALB security group | Next.js (if ALB in use) |
| Inbound | TCP | 8080 | Private subnet CIDR | Go backend from internal services |
| Outbound | All | All | 0.0.0.0/0 | Outbound internet/AWS |

### sg-java-service (attached to java-service EC2)

| Direction | Protocol | Port | Source/Destination | Purpose |
|---|---|---|---|---|
| Inbound | TCP | 22 | Your admin CIDR | SSH |
| Inbound | TCP | 8081 | sg-frontend-backend | Spring Boot API |
| Outbound | TCP | 5432 | sg-postgres | Database |
| Outbound | All | All | 0.0.0.0/0 | Outbound internet/AWS |

### sg-express-service (attached to express-service EC2)

| Direction | Protocol | Port | Source/Destination | Purpose |
|---|---|---|---|---|
| Inbound | TCP | 22 | Your admin CIDR | SSH |
| Inbound | TCP | 3001 | sg-frontend-backend | Express API |
| Outbound | TCP | 5432 | sg-postgres | Database |
| Outbound | All | All | 0.0.0.0/0 | Outbound internet/AWS |

### sg-postgres (attached to PostgreSQL EC2 or RDS)

| Direction | Protocol | Port | Source/Destination | Purpose |
|---|---|---|---|---|
| Inbound | TCP | 22 | Your admin CIDR | SSH (EC2 only) |
| Inbound | TCP | 5432 | 10.x.0.0/16 (VPC CIDR) | All internal services |
| Outbound | All | All | 0.0.0.0/0 | Outbound |

---

## Deployment: Running Scripts on Each Instance

SSH into each EC2 instance and run the corresponding script. All scripts must be
run as `root` or via `sudo`. Run `setup-common.sh` **first** on every instance
before the service-specific scripts.

### Step 1 — All instances: common bootstrap

```bash
sudo bash /opt/griddog/deploy/vm/setup-common.sh
```

This installs Docker, git, jq, creates the `griddog` OS user, clones the repo
to `/opt/griddog`, and configures UFW firewall rules.

### Step 2 — PostgreSQL instance

```bash
sudo bash /opt/griddog/deploy/vm/setup-postgres.sh
```

Installs PostgreSQL 15, creates the `griddog` database and user, runs `init.sql`,
and configures `pg_hba.conf` to accept connections from the private subnet.

### Step 3 — Java service instance

```bash
# Build the JAR first (on a CI runner or the instance itself):
# cd /opt/griddog/java-service && ./gradlew bootJar

sudo DATABASE_URL="jdbc:postgresql://POSTGRES_PRIVATE_IP:5432/griddog" \
     DB_USER="griddog" \
     DB_PASSWORD="griddog" \
     bash /opt/griddog/deploy/vm/setup-java.sh
```

### Step 4 — Express service instance

```bash
sudo DATABASE_URL="postgres://griddog:griddog@POSTGRES_PRIVATE_IP:5432/griddog?sslmode=disable" \
     bash /opt/griddog/deploy/vm/setup-express.sh
```

### Step 5 — Frontend + Backend instance

Deploy the Go backend:

```bash
sudo JAVA_SERVICE_URL="http://JAVA_PRIVATE_IP:8081" \
     EXPRESS_SERVICE_URL="http://EXPRESS_PRIVATE_IP:3001" \
     DATABASE_URL="postgres://griddog:griddog@POSTGRES_PRIVATE_IP:5432/griddog?sslmode=disable" \
     bash /opt/griddog/deploy/vm/setup-backend.sh
```

Deploy the Next.js frontend:

```bash
sudo NEXT_PUBLIC_BACKEND_URL="https://api.your-domain.com" \
     bash /opt/griddog/deploy/vm/setup-frontend.sh
```

---

## DNS and Load Balancer Notes

### Application Load Balancer (ALB)

It is recommended to place an ALB in front of the frontend+backend instance:

- **Listener 443 (HTTPS)** — forward to target group `tg-frontend` (port 3000)
  or `tg-backend` (port 8080) based on path prefix:
  - `/api/*` → backend (port 8080)
  - `/*`     → frontend (port 3000)
- **Listener 80 (HTTP)** — redirect to 443.
- Attach an ACM certificate to the 443 listener.

### Route 53

Create DNS records pointing to the ALB DNS name:

| Record | Type | Value |
|---|---|---|
| app.th.griddog.example.com | CNAME | ALB DNS (Thailand) |
| app.sg.griddog.example.com | CNAME | ALB DNS (Singapore) |
| app.griddog.example.com | CNAME (latency) | Route to nearest region via Route 53 latency routing |

---

## Environment Variable Configuration Table

The table below summarises all environment variables consumed by each service and
where to set them (systemd unit file or build-time for Next.js).

| Variable | Service | Where Set | Example Value |
|---|---|---|---|
| `PORT` | backend, express, java | systemd `Environment=` | `8080` / `3001` / `8081` |
| `DATABASE_URL` | backend, express | systemd `Environment=` | `postgres://griddog:griddog@HOST:5432/griddog?sslmode=disable` |
| `JAVA_SERVICE_URL` | backend | systemd `Environment=` | `http://10.7.2.11:8081` |
| `EXPRESS_SERVICE_URL` | backend | systemd `Environment=` | `http://10.7.2.12:3001` |
| `SPRING_DATASOURCE_URL` | java-service | systemd `Environment=` | `jdbc:postgresql://HOST:5432/griddog` |
| `SPRING_DATASOURCE_USERNAME` | java-service | systemd `Environment=` | `griddog` |
| `SPRING_DATASOURCE_PASSWORD` | java-service | systemd `Environment=` | `griddog` |
| `SPRING_PROFILES_ACTIVE` | java-service | systemd `Environment=` | `production` |
| `NODE_ENV` | express, frontend | systemd `Environment=` | `production` |
| `NEXT_PUBLIC_BACKEND_URL` | frontend | build-time + systemd | `https://api.th.griddog.example.com` |

> **Security note:** For production deployments, store secrets (database
> passwords, API keys) in AWS Secrets Manager or SSM Parameter Store and inject
> them at startup via an init script rather than hardcoding them in systemd unit
> files or source control.
