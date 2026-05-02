output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API endpoint"
  value       = module.eks.cluster_endpoint
}

output "region" {
  description = "AWS region"
  value       = var.aws_region
}

output "kubeconfig_update_command" {
  description = "Run this once to point kubectl at the new cluster"
  value       = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.aws_region}"
}

output "ecr_urls" {
  description = "ECR repo URLs, keyed by service name"
  value = {
    for repo in aws_ecr_repository.services :
    replace(repo.name, "griddog/", "") => repo.repository_url
  }
}

output "ecr_registry" {
  description = "ECR registry hostname (account-id.dkr.ecr.region.amazonaws.com)"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (set as repo secret)"
  value       = aws_iam_role.github_actions.arn
}

output "shared_nat_eip" {
  description = "NAT GW EIP shared with VM stack — add to ALB inbound-cidrs allowlist as /32"
  value       = data.aws_eip.vm_nat.public_ip
}

output "private_subnet_ids" {
  description = "Private subnets (frontend/backend NGs span both, databases NG pinned to 1b)"
  value = {
    "1a" = aws_subnet.private_1a.id
    "1b" = aws_subnet.private_1b.id
  }
}

output "public_subnet_ids" {
  description = "Public subnets (used by ALB)"
  value = {
    "1a" = aws_subnet.public_1a.id
    "1b" = aws_subnet.public_1b.id
  }
}
