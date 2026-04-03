variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Environment name (used in tags and naming)"
  type        = string
  default     = "sg"
}

variable "availability_zone" {
  description = "Primary AZ for EC2 instances and private subnet"
  type        = string
  default     = "ap-southeast-1b"
}

variable "admin_cidr" {
  description = "CIDR block allowed for SSH access (e.g. 1.2.3.4/32)"
  type        = string
}

variable "alb_allowed_cidrs" {
  description = "List of CIDRs allowed to access the ALB on port 80 (e.g. your IP, office IP)"
  type        = list(string)
}

variable "key_name" {
  description = "EC2 key pair name for SSH access"
  type        = string
}



variable "db_password" {
  description = "Password for PostgreSQL (griddog user) and MongoDB (griddog user)"
  type        = string
  sensitive   = true
}

variable "datadog_api_key" {
  description = "Datadog API key — stored in SSM SecureString"
  type        = string
  sensitive   = true
  default     = "placeholder"
}
