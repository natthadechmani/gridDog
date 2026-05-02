variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-1"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "griddog-eks"
}

variable "cluster_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.30"
}

variable "vpc_id" {
  description = "Existing default VPC ID (shared with VM stack)"
  type        = string
  default     = "vpc-0169d769cd12ce2ae"
}

variable "admin_cidrs" {
  description = "CIDRs allowed to reach the EKS public API endpoint and the ALB"
  type        = list(string)
  # Example: ["1.2.3.4/32"]   ← run: curl ifconfig.me
}

variable "github_repo" {
  description = "GitHub repo (org/name) allowed to assume the OIDC role for ECR push"
  type        = string
  default     = "natthadechmani/gridDog"
}

variable "github_branch" {
  description = "Git branch allowed to push images via OIDC"
  type        = string
  default     = "master"
}

# Per-NG disk sizes (GiB, gp3)
variable "node_disk_size_frontend" {
  type    = number
  default = 30
}

variable "node_disk_size_backend" {
  type    = number
  default = 30
}

variable "node_disk_size_databases" {
  type    = number
  default = 20
}
