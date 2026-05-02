# ---------------------------------------------------------------------------
# Use existing default VPC (172.31.0.0/16)
# ---------------------------------------------------------------------------
data "aws_vpc" "main" {
  id = "vpc-0169d769cd12ce2ae"
}

# Use the existing Internet Gateway attached to the default VPC
data "aws_internet_gateway" "main" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.main.id]
  }
}

# ---------------------------------------------------------------------------
# New subnets — using 172.31.64.x to avoid existing subnet conflicts
# ---------------------------------------------------------------------------

# Primary public subnet (ap-southeast-1b) — nginx EC2 lives here
resource "aws_subnet" "public" {
  vpc_id                  = data.aws_vpc.main.id
  cidr_block              = "172.31.64.0/24"
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = { Name = "griddog-public" }
}

# Secondary public subnet (ap-southeast-1a) — required by ALB (min 2 AZs)
resource "aws_subnet" "public_secondary" {
  vpc_id                  = data.aws_vpc.main.id
  cidr_block              = "172.31.65.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = false

  tags = { Name = "griddog-public-secondary" }
}

# Private subnet (ap-southeast-1b) — frontend, app, databases live here
resource "aws_subnet" "private" {
  vpc_id            = data.aws_vpc.main.id
  cidr_block        = "172.31.66.0/24"
  availability_zone = var.availability_zone

  tags = { Name = "griddog-private" }
}

# ---------------------------------------------------------------------------
# NAT Gateway (new — default VPC doesn't have one)
# ---------------------------------------------------------------------------
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = { Name = "griddog-eip-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  depends_on    = [data.aws_internet_gateway.main]

  tags = { Name = "griddog-nat-gw" }
}

# ---------------------------------------------------------------------------
# Route tables
# ---------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = data.aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = data.aws_internet_gateway.main.id
  }

  tags = { Name = "griddog-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_secondary" {
  subnet_id      = aws_subnet.public_secondary.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = data.aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "griddog-private-rt" }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}
