# GridDog — Terraform Infrastructure (EKS, Singapore / ap-southeast-1)

Provisions the AWS infrastructure for the GridDog EKS deployment. Does **not** deploy the app — apply the per-service YAML files in [../manifests/](../manifests/) for that (see [../README.md](../README.md)).

---

## What this creates

| Resource | Details |
|---|---|
| Subnets | 4 new subnets in the existing default VPC: `griddog-eks-public-1a/1b` (172.31.80-81/24), `griddog-eks-private-1a/1b` (172.31.82-83/24) |
| Route tables | `griddog-eks-public-rt` (→ existing IGW), `griddog-eks-private-rt` (→ shared VM-stack NAT GW) |
| EKS cluster | `griddog-eks` v1.30, public+private API endpoint (public restricted to admin CIDRs) |
| Managed node groups | `frontend` (1× t3.medium), `backend` (2× t3.medium), `databases` (1× t3.medium, AZ-pinned + tainted) |
| EKS addons | `vpc-cni`, `kube-proxy`, `coredns`, `aws-ebs-csi-driver` (with IRSA), `eks-pod-identity-agent` |
| ECR repos (6) | `griddog/backend`, `griddog/java-service`, `griddog/express-service`, `griddog/dotnet-scheduler`, `griddog/frontend`, `griddog/traffic` — scan-on-push, lifecycle: keep last 10 untagged |
| IAM IRSA roles | `griddog-eks-alb-controller` (AWS Load Balancer Controller), `griddog-eks-ebs-csi` (EBS CSI Driver) |
| GitHub Actions OIDC | `griddog-eks-github-actions` IAM role + OIDC provider; lets CI push to ECR without long-lived keys |
| Helm releases | `aws-load-balancer-controller` in `kube-system` (provisions ALBs from Ingress YAML) |

> **Reuses, does not create:** the default VPC (`vpc-0169d769cd12ce2ae`), its IGW, and the VM stack's NAT GW (`griddog-nat-gw`) + EIP. `terraform destroy` does not touch any of these.

---

## Prerequisites

### 1. Install tools
```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
brew install awscli kubectl
terraform --version    # >= 1.6
```

### 2. AWS SSO (already configured by VM stack)
```bash
aws sso login --profile griddog
aws sts get-caller-identity --profile griddog
export AWS_PROFILE=griddog
```

### 3. VM stack must be applied first
This stack depends on the VM stack's NAT GW + EIP via `data` lookups. If the VM stack hasn't been applied, `terraform apply` here will fail with "no matching NAT Gateway found." Apply [../../vm/terraform/](../../vm/terraform/) first.

---

## First-time setup

```bash
cd deploy/kubernetes/terraform

cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

### Variable reference

| Variable | Description | Default |
|---|---|---|
| `admin_cidrs` | Your IP(s) for EKS public API + ALB ingress allowlist. Run: `curl ifconfig.me`. **Required.** | — |
| `aws_region` | AWS region | `ap-southeast-1` |
| `cluster_name` | EKS cluster name | `griddog-eks` |
| `cluster_version` | Kubernetes version | `1.30` |
| `vpc_id` | Existing default VPC ID | `vpc-0169d769cd12ce2ae` |
| `github_repo` | GitHub repo allowed to assume OIDC role | `natthadechmani/gridDog` |
| `github_branch` | Git branch allowed to push images via OIDC | `master` |
| `node_disk_size_frontend` | Root disk size GiB for frontend NG | `30` |
| `node_disk_size_backend` | Root disk size GiB for backend NG | `30` |
| `node_disk_size_databases` | Root disk size GiB for databases NG | `20` |

---

## Deploy

```bash
terraform init                 # downloads providers + module
terraform plan                 # preview ~40 resources
terraform apply                # ~15-20 min (EKS control plane is the slow part)
```

What's slow:
- VPC subnet/route-table creation: <1 min
- EKS control plane: 10-12 min
- Managed node groups (3 in parallel): 3-5 min
- Helm install of AWS Load Balancer Controller: 1-2 min after the cluster is reachable

---

## After apply — useful outputs

```bash
terraform output cluster_name              # griddog-eks
terraform output kubeconfig_update_command # exact aws eks update-kubeconfig command
terraform output ecr_urls                  # map of service → repo URL
terraform output ecr_registry              # account-id.dkr.ecr.ap-southeast-1.amazonaws.com
terraform output github_actions_role_arn   # set as repo secret AWS_ECR_PUSH_ROLE_ARN
terraform output shared_nat_eip            # NAT EIP — add /32 to ALB inbound-cidrs
terraform output private_subnet_ids        # for debugging
terraform output public_subnet_ids
```

---

## Updating the cluster

```bash
# Re-authenticate if SSO expired
aws sso login --profile griddog

# Cluster version upgrade
$EDITOR terraform.tfvars   # bump cluster_version = "1.31"
terraform apply

# Node group resize (e.g. scale backend NG to 3 nodes)
# Edit eks.tf  → backend.desired_size = 3
terraform apply

# Add a new IRSA role
# Edit iam.tf, terraform apply
```

> **Don't forget:** node group changes can take 5-10 min and may temporarily reduce capacity during rolling updates. Drain pods first if running anything sensitive.

---

## Tear down

```bash
# Step 1 (CRITICAL): delete app manifests first so the AWS LB Controller
# cleans up the dynamic ALB before Terraform tries to delete the SG.
cd .. && make destroy   # deletes manifests in reverse order, waits for ALB cleanup, then runs terraform destroy

# Wait for ALB to be gone (~30-60s)
aws elbv2 describe-load-balancers --region ap-southeast-1 \
  --query 'LoadBalancers[?starts_with(LoadBalancerName, `k8s-griddoge`)].LoadBalancerName'

# Step 2: terraform destroy
terraform destroy
```

> **WARNING:** the VM stack's NAT GW is preserved (this stack only references it). Never `terraform destroy` the VM stack while this stack is running.

---

## File reference

| File | Purpose |
|---|---|
| `main.tf` | Provider config, required_providers, EKS auth data sources |
| `variables.tf` | All input variables |
| `vpc.tf` | Subnet creation + route tables + VM-stack NAT GW lookup |
| `eks.tf` | Cluster + 3 managed node groups + addons (via `terraform-aws-modules/eks/aws`) |
| `ecr.tf` | 6 ECR repos with scan-on-push and lifecycle policies |
| `iam.tf` | IRSA roles (ALB controller, EBS CSI), GitHub Actions OIDC role |
| `controllers.tf` | Helm release for AWS Load Balancer Controller |
| `outputs.tf` | Cluster name, ECR URLs, kubeconfig command, shared NAT EIP |
| `terraform.tfvars` | Your values — **gitignored, never commit** |
| `terraform.tfvars.example` | Template to copy |
