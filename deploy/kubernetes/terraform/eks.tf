# ---------------------------------------------------------------------------
# EKS cluster + 3 managed node groups
#   frontend    (1 node, t3.medium, multi-AZ-eligible)
#   backend     (2 nodes, t3.medium, anti-affinity spreads replicas across both)
#   databases   (1 node, t3.medium, AZ-pinned to 1b, tainted)
# ---------------------------------------------------------------------------

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.24"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  # Public API endpoint — restrict to admin CIDRs
  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.admin_cidrs

  vpc_id = data.aws_vpc.main.id
  subnet_ids = [
    aws_subnet.private_1a.id,
    aws_subnet.private_1b.id,
  ]
  control_plane_subnet_ids = [
    aws_subnet.private_1a.id,
    aws_subnet.private_1b.id,
  ]

  # Managed addons (kept here so they version-pin with the cluster)
  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    vpc-cni    = { most_recent = true }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = aws_iam_role.ebs_csi.arn
    }
    eks-pod-identity-agent = { most_recent = true }
  }

  # Grant the Terraform applier cluster-admin via Access Entries
  enable_cluster_creator_admin_permissions = true
  authentication_mode                      = "API_AND_CONFIG_MAP"

  # Common defaults applied to all 3 node groups
  eks_managed_node_group_defaults = {
    ami_type       = "AL2023_x86_64_STANDARD"
    instance_types = ["t3.medium"]
    capacity_type  = "ON_DEMAND"

    # Tags propagated to the EC2 instances + EBS volumes via the
    # node group's launch template tag_specifications.
    tags = {
      datadog = "griddog"
    }
  }

  eks_managed_node_groups = {
    frontend = {
      name         = "${var.cluster_name}-frontend"
      min_size     = 1
      max_size     = 2
      desired_size = 1
      disk_size    = var.node_disk_size_frontend
      subnet_ids   = [aws_subnet.private_1a.id, aws_subnet.private_1b.id]
      labels       = { "griddog.io/role" = "frontend" }
    }

    backend = {
      name         = "${var.cluster_name}-backend"
      min_size     = 2
      max_size     = 4
      desired_size = 2
      disk_size    = var.node_disk_size_backend
      subnet_ids   = [aws_subnet.private_1a.id, aws_subnet.private_1b.id]
      labels       = { "griddog.io/role" = "backend" }
    }

    databases = {
      name         = "${var.cluster_name}-databases"
      min_size     = 1
      max_size     = 1
      desired_size = 1
      disk_size    = var.node_disk_size_databases
      # AZ-pinned to 1b so EBS PVCs always bind cleanly
      subnet_ids = [aws_subnet.private_1b.id]
      labels     = { "griddog.io/role" = "databases" }
      taints = {
        databases = {
          key    = "griddog.io/role"
          value  = "databases"
          effect = "NO_SCHEDULE"
        }
      }
    }
  }

  tags = {
    Project = "griddog"
    Stack   = "eks"
  }
}
