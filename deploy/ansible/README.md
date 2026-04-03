# Ansible Deployment Guide

Deploys GridDog services as Docker containers across 4 EC2 instances provisioned by Terraform.

---

## Architecture

```
Internet
    │
    ▼ HTTP :80  (restricted to alb_allowed_cidrs)
┌─────────────────────────────────┐
│  ALB  (Application Load Balancer)│
└─────────────────────────────────┘
    │
    ▼ HTTP :80
┌─────────────────────────────────┐
│  griddog-nginx  (public IP)      │  ← also SSH bastion for private EC2s
│  container: nginx                │
└─────────────────────────────────┘
    │ reverse proxy
    ├──────────────────────────────────────────┐
    ▼ :3000                                    ▼ :8080
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  griddog-frontend        │    │  griddog-app                     │
│  griddog-frontend (Next) │    │  griddog-backend (Go :8080)      │
│  griddog-traffic  (Puppeteer :3002)  griddog-java-service (:8081) │
└──────────────────────────┘    │  griddog-express-service (:3001) │
    │                           └──────────────────────────────────┘
    │ Puppeteer synthetic traffic         │ private IP
    │ (frontend EC2 → ALB → nginx)        ▼
    │                           ┌──────────────────────────┐
    │                           │  griddog-databases       │
    │                           │  postgres  :5432         │
    │                           │  mongodb   :27017        │
    │                           └──────────────────────────┘
    │
    └── traffic control API  (backend → frontend :3002)
```

### EC2 summary

| EC2 | Containers | Exposed ports |
|-----|------------|---------------|
| griddog-nginx | nginx | :80 (public) |
| griddog-frontend | griddog-frontend, griddog-traffic | :3000, :3002 |
| griddog-app | griddog-backend, griddog-java-service, griddog-express-service | :8080 |
| griddog-databases | postgres, mongodb | :5432, :27017 |

### Networking rules

- Only nginx has a public IP. All other EC2s are private (VPC only).
- nginx acts as both HTTP reverse proxy and SSH bastion (jump host).
- Services on the same EC2 communicate via Docker container names (same Docker network).
- Cross-EC2 communication uses private IPs templated into environment variables.
- The traffic generator (Puppeteer) on griddog-frontend sends synthetic traffic through the ALB. The backend controls it via `TRAFFIC_SERVICE_URL` pointing to `frontend_private_ip:3002`.

---

## Prerequisites

### 1. Install Ansible

On macOS, `pip3 install ansible` fails with `externally-managed-environment`. Use `pipx` instead:

```bash
brew install pipx
pipx install ansible-core
pipx inject ansible-core ansible   # community modules
```

Then add pipx to your PATH (add to `~/.zshrc` or `~/.bashrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Reload your shell:

```bash
source ~/.zshrc
ansible --version   # should print version
```

Install the Docker collection (needed for `community.docker.docker_compose_v2`):

```bash
ansible-galaxy collection install community.docker
ansible-galaxy collection install community.general
```

### 2. SSH key

Download `griddog-keypair.pem` from AWS EC2 → Key Pairs and place it at `~/.ssh/griddog-keypair.pem`:

```bash
chmod 400 ~/.ssh/griddog-keypair.pem
```

---

## Setup

### 1. Apply Terraform (if not done already)

```bash
cd deploy/terraform
aws sso login --profile griddog        # refresh SSO if expired
AWS_PROFILE=griddog terraform apply
```

Note the outputs — you'll need them for the next steps:

```bash
AWS_PROFILE=griddog terraform output
```

### 2. Fill in `inventory.ini`

Edit `deploy/ansible/inventory.ini` with IPs from `terraform output`:

```ini
[nginx]
griddog-nginx ansible_host=54.x.x.x

[frontend]
griddog-frontend ansible_host=172.31.x.x ansible_ssh_common_args='-J ubuntu@54.x.x.x -i ~/.ssh/griddog-keypair.pem'

[app]
griddog-app ansible_host=172.31.x.x ansible_ssh_common_args='-J ubuntu@54.x.x.x -i ~/.ssh/griddog-keypair.pem'

[databases]
griddog-databases ansible_host=172.31.x.x ansible_ssh_common_args='-J ubuntu@54.x.x.x -i ~/.ssh/griddog-keypair.pem'
```

Private EC2s use nginx as an SSH jump host (`-J`). nginx itself is reached directly by its public IP.

### 3. Create `group_vars/all.yml`

```bash
cd deploy/ansible
cp group_vars/all.yml.example group_vars/all.yml
```

Edit `group_vars/all.yml` and fill in:

```yaml
# GitHub Personal Access Token (repo scope)
# Create at: https://github.com/settings/tokens
github_pat: "ghp_xxxxxxxxxxxxxxxxxxxx"
repo_url: "https://{{ github_pat }}@github.com/natthadechmani/gridDog.git"
repo_branch: master
repo_dir: /opt/griddog

# Must match what you set in deploy/terraform/terraform.tfvars
db_password: "your-db-password"

# From: terraform output
nginx_public_ip:      "54.x.x.x"
app_private_ip:       "172.31.x.x"
frontend_private_ip:  "172.31.x.x"
databases_private_ip: "172.31.x.x"

# From: terraform output alb_dns_name
alb_dns: "griddog-alb-xxxx.ap-southeast-1.elb.amazonaws.com"
```

> `group_vars/all.yml` is gitignored — never commit it.

### 4. Ensure your IP is in the ALB allowlist

The ALB only accepts HTTP from the CIDRs listed in `deploy/terraform/terraform.tfvars`:

```hcl
alb_allowed_cidrs = ["YOUR.IP.ADDRESS/32"]
```

If your IP changes, update this and run `AWS_PROFILE=griddog terraform apply` again.

### 5. Accept SSH host keys for private EC2s

The first time you connect, SSH asks to verify host keys. Pre-accept them by SSHing directly:

```bash
ssh -i ~/.ssh/griddog-keypair.pem ubuntu@<NGINX_PUBLIC_IP>
# type 'yes'

ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<FRONTEND_PRIVATE_IP>
# type 'yes'

ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<APP_PRIVATE_IP>
# type 'yes'

ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<DATABASES_PRIVATE_IP>
# type 'yes'
```

### 6. Test connectivity

```bash
cd deploy/ansible
ansible all -m ping
```

All 4 hosts should return `pong`.

---

## Deploy

### Deploy everything (first time or full redeploy)

```bash
ansible-playbook site.yml
```

### Deploy one EC2 at a time (recommended for first run)

Run in this order — later services depend on earlier ones:

```bash
ansible-playbook playbooks/01_databases.yml   # postgres + mongodb
ansible-playbook playbooks/02_app.yml         # backend + java-service + express (needs databases)
ansible-playbook playbooks/03_frontend.yml    # Next.js + Puppeteer traffic generator
ansible-playbook playbooks/04_nginx.yml       # nginx reverse proxy (needs frontend + app IPs)
```

### Redeploy after code changes

Only redeploy the EC2 that changed:

```bash
ansible-playbook playbooks/02_app.yml      # after backend / java-service / express-service changes
ansible-playbook playbooks/03_frontend.yml # after frontend changes
ansible-playbook playbooks/04_nginx.yml    # after nginx.conf changes
```

---

## Traffic Generator (Puppeteer)

The `griddog-traffic` container runs on griddog-frontend and generates synthetic HTTP traffic through the ALB to exercise the backend.

- **Container**: `griddog-traffic` on griddog-frontend EC2
- **Port**: `3002` — exposes a control API
- **Env**: `TRAFFIC_BASE_URL=http://<alb_dns>` — sends traffic through the ALB
- **Backend integration**: `griddog-backend` calls `http://<frontend_private_ip>:3002` to start/stop traffic (set via `TRAFFIC_SERVICE_URL`)

After deploying, check that both containers are running on the frontend EC2:

```bash
ansible frontend -m shell -a "docker ps"
# Expected: griddog-frontend (Up) + griddog-traffic (Up)
```

---

## Verify

```bash
# Check running containers on each EC2
ansible databases -m shell -a "docker ps"
ansible app       -m shell -a "docker ps"
ansible frontend  -m shell -a "docker ps"
ansible nginx     -m shell -a "docker ps"

# Check container logs
ansible app      -m shell -a "docker logs griddog-backend --tail 50"
ansible frontend -m shell -a "docker logs griddog-traffic --tail 50"

# Hit the app through the ALB
curl http://<alb_dns>/health
curl http://<alb_dns>/nginx-health
```

---

## SSH into EC2s manually

```bash
# nginx (public — direct)
ssh -i ~/.ssh/griddog-keypair.pem ubuntu@<NGINX_PUBLIC_IP>

# Private EC2s (via nginx as jump host)
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<FRONTEND_PRIVATE_IP>
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<APP_PRIVATE_IP>
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<DATABASES_PRIVATE_IP>
```

---

## Directory structure

```
deploy/ansible/
├── ansible.cfg                          # SSH key, remote user, inventory path
├── inventory.ini                        # Hosts + IPs (fill from terraform output)
├── site.yml                             # Master playbook — runs all 4 in order
├── group_vars/
│   ├── all.yml                          # Secrets + IPs — GITIGNORED
│   └── all.yml.example                  # Template (safe to commit)
├── playbooks/
│   ├── 01_databases.yml                 # postgres + mongodb on griddog-databases
│   ├── 02_app.yml                       # backend + java-service + express on griddog-app
│   ├── 03_frontend.yml                  # frontend + traffic generator on griddog-frontend
│   └── 04_nginx.yml                     # nginx on griddog-nginx
└── templates/
    ├── docker-compose.databases.yml.j2  # postgres + mongodb
    ├── docker-compose.app.yml.j2        # backend + java-service + express-service
    ├── docker-compose.frontend.yml.j2   # Next.js frontend + Puppeteer traffic generator
    ├── docker-compose.nginx.yml.j2      # nginx container
    └── nginx.conf.j2                    # nginx reverse proxy config (uses private IPs)
```

---

## Troubleshooting

### `pip3 install ansible` fails with "externally-managed-environment"

macOS prevents pip3 from installing packages globally. Use pipx:

```bash
brew install pipx
pipx install ansible-core
pipx inject ansible-core ansible
export PATH="$HOME/.local/bin:$PATH"
```

### `ansible` command not found after pipx install

pipx installs to `~/.local/bin`. Add it to PATH in `~/.zshrc`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### `community.docker.docker_compose_v2` not found

```bash
ansible-galaxy collection install community.docker
ansible-galaxy collection install community.general
```

### Private EC2s — "Host key verification failed"

SSH needs to verify the host key before Ansible can connect. SSH in manually first and type `yes`:

```bash
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<NGINX_PUBLIC_IP> ubuntu@<PRIVATE_IP>
```

### Private EC2 SSH connection times out

The nginx EC2 security group needs egress rules on port 22 to the private EC2 security groups. These are defined in `deploy/terraform/security_groups.tf` as `nginx_egress_ssh_*`. If missing, run `AWS_PROFILE=griddog terraform apply`.

### Repo branch not found during clone

Check `repo_branch` in `group_vars/all.yml`. This repo uses `master`, not `main`.

### Frontend Dockerfile fails — `/app/public: not found`

The Dockerfile expects a `public/` directory. Create it:

```bash
mkdir -p frontend/public
touch frontend/public/.gitkeep
git add frontend/public/.gitkeep
git push
```

### nginx container crash loop — "upstream directive is not allowed here"

`nginx.conf` must have `events {}` and `http {}` blocks. The `upstream` and `server` blocks must be inside `http {}`. Check `templates/nginx.conf.j2`.

### nginx config change not applied after re-running playbook

`docker_compose_v2` only recreates containers when the compose file changes. If only `nginx.conf` changed, force a restart:

```bash
# SSH into nginx EC2
ssh -i ~/.ssh/griddog-keypair.pem ubuntu@<NGINX_PUBLIC_IP>
docker restart griddog-nginx
```

Or re-run the playbook with `--force-handlers` if the template task triggered a notify.

### ALB times out (connection refused or timeout)

Your IP may not be in `alb_allowed_cidrs`. Update `deploy/terraform/terraform.tfvars`:

```hcl
alb_allowed_cidrs = ["YOUR.CURRENT.IP/32"]
```

Then:

```bash
AWS_PROFILE=griddog terraform apply
```

### Terraform credentials error — "no valid credential sources"

AWS SSO session expired. Re-login:

```bash
aws sso login --profile griddog
AWS_PROFILE=griddog terraform apply   # use as prefix, not export
```

### Traffic generator shows "CONTAINER NOT ACTIVE"

Three things must all be in place:

1. `griddog-traffic` container is running on griddog-frontend (`docker ps`)
2. `TRAFFIC_SERVICE_URL` is set in the backend environment (`docker-compose.app.yml.j2`)
3. SG rules exist: app → frontend :3002 (egress) and frontend ← app :3002 (ingress)

Run `ansible-playbook playbooks/02_app.yml` and `playbooks/03_frontend.yml` to redeploy both.

### Docker build fails — out of disk

```bash
ansible all -m shell -a "docker system prune -f"
```

### GitHub clone fails — 401 Unauthorized

- Check `github_pat` in `group_vars/all.yml`
- The PAT needs `repo` scope
- PATs expire — generate a new one at https://github.com/settings/tokens
