# ---------------------------------------------------------------------------
# Reuse the existing default VPC (shared with the VM stack).
# Do NOT create a new VPC. CIDRs picked to avoid collision with:
#   - Default subnets:    172.31.0.0/20, 172.31.16.0/20, 172.31.32.0/20
#   - RDS subnets:        172.31.48.0/25, 172.31.48.128/25, 172.31.49.0/25
#   - VM stack:           172.31.64.0/24, 172.31.65.0/24, 172.31.66.0/24
# EKS subnets land at 172.31.80-83.0/24.
# ---------------------------------------------------------------------------

data "aws_vpc" "main" {
  id = var.vpc_id
}

data "aws_internet_gateway" "main" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.main.id]
  }
}

# ---------------------------------------------------------------------------
# Shared NAT GW (owned by VM stack — DO NOT destroy the VM stack while EKS is running).
# Looked up by Name tag.
# ---------------------------------------------------------------------------
data "aws_nat_gateway" "vm_shared" {
  filter {
    name   = "tag:Name"
    values = ["griddog-nat-gw"]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
}

data "aws_eip" "vm_nat" {
  filter {
    name   = "tag:Name"
    values = ["griddog-eip-nat"]
  }
}

# ---------------------------------------------------------------------------
# New subnets — 4 total (2 public + 2 private, across 2 AZs)
# Required-by-EKS tags applied so the AWS Load Balancer Controller can
# discover them and so EKS knows about them.
# ---------------------------------------------------------------------------

locals {
  cluster_subnet_tag = "kubernetes.io/cluster/${var.cluster_name}"
}

resource "aws_subnet" "public_1a" {
  vpc_id                  = data.aws_vpc.main.id
  cidr_block              = "172.31.80.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name                       = "griddog-eks-public-1a"
    "kubernetes.io/role/elb"   = "1"
    (local.cluster_subnet_tag) = "shared"
  }
}

resource "aws_subnet" "public_1b" {
  vpc_id                  = data.aws_vpc.main.id
  cidr_block              = "172.31.81.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name                       = "griddog-eks-public-1b"
    "kubernetes.io/role/elb"   = "1"
    (local.cluster_subnet_tag) = "shared"
  }
}

resource "aws_subnet" "private_1a" {
  vpc_id            = data.aws_vpc.main.id
  cidr_block        = "172.31.82.0/24"
  availability_zone = "${var.aws_region}a"

  tags = {
    Name                              = "griddog-eks-private-1a"
    "kubernetes.io/role/internal-elb" = "1"
    (local.cluster_subnet_tag)        = "shared"
  }
}

resource "aws_subnet" "private_1b" {
  vpc_id            = data.aws_vpc.main.id
  cidr_block        = "172.31.83.0/24"
  availability_zone = "${var.aws_region}b"

  tags = {
    Name                              = "griddog-eks-private-1b"
    "kubernetes.io/role/internal-elb" = "1"
    (local.cluster_subnet_tag)        = "shared"
  }
}

# ---------------------------------------------------------------------------
# Route tables
#   public  → existing IGW
#   private → shared VM-stack NAT GW (saves ~$35/mo vs a new NAT GW)
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = data.aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = data.aws_internet_gateway.main.id
  }

  tags = { Name = "griddog-eks-public-rt" }
}

resource "aws_route_table_association" "public_1a" {
  subnet_id      = aws_subnet.public_1a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_1b" {
  subnet_id      = aws_subnet.public_1b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = data.aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = data.aws_nat_gateway.vm_shared.id
  }

  tags = { Name = "griddog-eks-private-rt" }
}

resource "aws_route_table_association" "private_1a" {
  subnet_id      = aws_subnet.private_1a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_1b" {
  subnet_id      = aws_subnet.private_1b.id
  route_table_id = aws_route_table.private.id
}
