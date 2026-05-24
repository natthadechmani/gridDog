# GridDog — Terraform Infrastructure (Singapore / ap-southeast-1)

Provisions the AWS infrastructure for the GridDog VM deployment. Does **not** deploy the app — use the Ansible playbook for that.

---

## What this creates

| Resource | Details |
|---|---|
| Subnets | 3 new subnets inside the existing default VPC (172.31.64–66.0/24) |
| NAT Gateway | New NAT GW + Elastic IP in public subnet |
| Route tables | Public (→ IGW) and private (→ NAT GW) |
| Security groups | griddog-ec2-alb, griddog-ec2-nginx, griddog-ec2-frontend, griddog-ec2-app, griddog-ec2-databases |
| EC2 instances | 4× Ubuntu 24.04 (nginx t3.micro, frontend t3.micro, app t3.small, databases t3.small) |
| EBS volumes | 2× 8 GB gp3 attached to databases EC2 (/dev/xvdf for Postgres, /dev/xvdg for MongoDB) |
| ALB | Application Load Balancer (HTTP :80 → nginx EC2) |
| SSM parameters | `/griddog/sg/db_password`, `/griddog/sg/dd_api_key` (SecureString) |
| IAM role | EC2 instance profile with permission to read SSM parameters |

> Uses the existing default VPC (`vpc-0169d769cd12ce2ae`, 172.31.0.0/16) and its Internet Gateway — no new VPC is created.

---

## Prerequisites

### 1. Install tools
```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
brew install awscli

terraform --version   # need >= 1.6
aws --version
```

### 2. Authenticate via AWS SSO

The profile is already configured in `~/.aws/config`. Just log in:

```bash
aws sso login --profile griddog
aws sts get-caller-identity --profile griddog   # verify — should print account 369042512949
```

If you're on a fresh machine and need to set up the profile first:

```bash
aws configure sso
# SSO session name:  griddog
# SSO start URL:     https://d-906757b57c.awsapps.com/start/#
# SSO region:        us-east-1
# Account ID:        369042512949
# Role:              account-admin
# Default region:    ap-southeast-1
# Output format:     json
# CLI profile name:  griddog
```

### 3. Create an EC2 key pair (one-time)
```bash
aws ec2 create-key-pair \
  --key-name griddog-keypair \
  --query 'KeyMaterial' \
  --output text \
  --region ap-southeast-1 \
  --profile griddog > ~/.ssh/griddog-keypair.pem

chmod 400 ~/.ssh/griddog-keypair.pem
```

---

## First-time setup

```bash
cd deploy/vm/terraform

# Copy the example and fill in real values
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

| Variable | Description | Example |
|---|---|---|
| `admin_cidr` | List of IPs for SSH — run `curl ifconfig.me` then append `/32` | `["1.2.3.4/32", "5.6.7.8/32"]` |
| `alb_allowed_cidrs` | List of IPs that can reach the ALB on port 80 | `["1.2.3.4/32"]` |
| `key_name` | EC2 key pair created above | `griddog-keypair` |
| `db_password` | Password for Postgres + MongoDB | `MyStr0ngPass!` |
| `datadog_api_key` | Datadog API key (leave `placeholder` if not ready) | `abc123...` |

```bash
# Download providers (once)
export AWS_PROFILE=griddog
terraform init
```

---

## Deploy

```bash
export AWS_PROFILE=griddog

# Preview what will be created (~30 resources)
terraform plan

# Apply (takes ~5–8 minutes — NAT GW and ALB are slow)
terraform apply
# Type "yes" when prompted
```

### After apply — grab outputs
```bash
terraform output
```

Key outputs:
```
alb_dns_name    = "griddog-alb-74035986.ap-southeast-1.elb.amazonaws.com"
app_url         = "http://griddog-alb-74035986.ap-southeast-1.elb.amazonaws.com"
nginx_public_ip = "54.254.196.99"
private_ips     = { nginx = "172.31.64.218", frontend = "172.31.66.28", app = "172.31.66.214", databases = "172.31.66.145" }
ssh_commands    = {
  nginx     = "ssh -i ~/.ssh/griddog-keypair.pem ubuntu@54.254.196.99"
  frontend  = "ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@54.254.196.99 ubuntu@172.31.66.28"
  app       = "ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@54.254.196.99 ubuntu@172.31.66.214"
  databases = "ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@54.254.196.99 ubuntu@172.31.66.145"
}
```

---

## SSH access

nginx is in the public subnet and acts as the bastion for all private instances.

```bash
# SSH to nginx (direct)
ssh -i ~/.ssh/griddog-keypair.pem ubuntu@<nginx_public_ip>

# SSH to private instances (via nginx jump host)
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<nginx_public_ip> ubuntu@<frontend_private_ip>
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<nginx_public_ip> ubuntu@<app_private_ip>
ssh -i ~/.ssh/griddog-keypair.pem -J ubuntu@<nginx_public_ip> ubuntu@<databases_private_ip>
```

Use `terraform output ssh_commands` to get the exact commands with real IPs.

---

## Reading secrets on EC2

Each EC2 has an IAM instance profile that allows it to read SSM parameters:

```bash
# Run this on any EC2 to fetch the DB password
DB_PASS=$(aws ssm get-parameter \
  --name /griddog/sg/db_password \
  --with-decryption \
  --query Parameter.Value \
  --output text \
  --region ap-southeast-1)
```

---

## Redeploy / update

If you change any Terraform files:

```bash
export AWS_PROFILE=griddog

# Re-authenticate if session expired
aws sso login --profile griddog

terraform plan    # review what will change
terraform apply   # apply the changes
```

> Changing `user_data` in `ec2.tf` does NOT automatically re-run on existing EC2s (`user_data_replace_on_change = false`). SSH in and run commands manually, or terminate + re-create the instance.

---

## Add / update IPs (when your IP changes or at a client site)

### Option A — Terraform (permanent)

Edit `terraform.tfvars` and add the new IP to both lists:
```hcl
admin_cidr = [
  "42.61.131.119/32",  # home
  "CLIENT_IP/32",       # client site — get it with: curl ifconfig.me
]

alb_allowed_cidrs = [
  "42.61.131.119/32",
  "CLIENT_IP/32",
]
```

```bash
export AWS_PROFILE=griddog
terraform apply   # only updates the security group rules, no EC2 restarts
```

### Option B — AWS CLI (fast, temporary — best for on-site demos)

```bash
# Add your current IP instantly (no terraform needed)
MY_IP=$(curl -s ifconfig.me)
REGION="ap-southeast-1"

SG_NGINX=$(aws ec2 describe-security-groups --region $REGION --profile griddog --filters "Name=group-name,Values=griddog-ec2-nginx" --query 'SecurityGroups[0].GroupId' --output text)
SG_FRONTEND=$(aws ec2 describe-security-groups --region $REGION --profile griddog --filters "Name=group-name,Values=griddog-ec2-frontend" --query 'SecurityGroups[0].GroupId' --output text)
SG_APP=$(aws ec2 describe-security-groups --region $REGION --profile griddog --filters "Name=group-name,Values=griddog-ec2-app" --query 'SecurityGroups[0].GroupId' --output text)
SG_DB=$(aws ec2 describe-security-groups --region $REGION --profile griddog --filters "Name=group-name,Values=griddog-ec2-databases" --query 'SecurityGroups[0].GroupId' --output text)
SG_ALB=$(aws ec2 describe-security-groups --region $REGION --profile griddog --filters "Name=group-name,Values=griddog-ec2-alb" --query 'SecurityGroups[0].GroupId' --output text)

for SG in $SG_NGINX $SG_FRONTEND $SG_APP $SG_DB; do
  aws ec2 authorize-security-group-ingress --region $REGION --profile griddog \
    --group-id $SG --protocol tcp --port 22 --cidr "$MY_IP/32"
done
aws ec2 authorize-security-group-ingress --region $REGION --profile griddog \
  --group-id $SG_ALB --protocol tcp --port 80 --cidr "$MY_IP/32"

echo "Access granted for $MY_IP"
```

```bash
# Remove when done (cleanup)
for SG in $SG_NGINX $SG_FRONTEND $SG_APP $SG_DB; do
  aws ec2 revoke-security-group-ingress --region $REGION --profile griddog \
    --group-id $SG --protocol tcp --port 22 --cidr "$MY_IP/32"
done
aws ec2 revoke-security-group-ingress --region $REGION --profile griddog \
  --group-id $SG_ALB --protocol tcp --port 80 --cidr "$MY_IP/32"

echo "Access revoked for $MY_IP"
```

---

## Tear down

```bash
export AWS_PROFILE=griddog
terraform destroy
# Type "yes" — removes all griddog resources
# Does NOT delete the existing VPC, its subnets, or its IGW (those are shared)
```

> EBS data volumes are also destroyed. If you want to keep your data, snapshot the volumes first:
> ```bash
> aws ec2 create-snapshot --volume-id <vol-id> --description "griddog-backup" --region ap-southeast-1 --profile griddog
> ```

---

## File reference

| File | Purpose |
|---|---|
| `main.tf` | Provider config, optional S3 backend |
| `variables.tf` | All input variables |
| `vpc.tf` | References existing VPC/IGW, creates new subnets, NAT GW, route tables |
| `security_groups.tf` | All 5 security groups + rules (separated to avoid circular references) |
| `ec2.tf` | 4 EC2 instances + 2 EBS volumes + Ubuntu user_data (Docker install) |
| `alb.tf` | ALB, target group, HTTP listener |
| `ssm.tf` | SSM secrets + IAM role/instance profile |
| `outputs.tf` | App URL, IPs, SSH commands |
| `terraform.tfvars` | Your actual values — **gitignored, never commit** |
| `terraform.tfvars.example` | Template to copy |
