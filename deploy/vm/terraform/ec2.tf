# ---------------------------------------------------------------------------
# AMI — Ubuntu 24.04 LTS (matches the apt-based setup scripts)
# ---------------------------------------------------------------------------
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ---------------------------------------------------------------------------
# User data — runs setup-common.sh from the repo on first boot
# ---------------------------------------------------------------------------
locals {
  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    # Install prerequisites
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release git jq

    # Docker CE
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin

    systemctl enable docker
    systemctl start docker

    # griddog OS user
    useradd --system --shell /bin/bash --create-home griddog || true
    usermod -aG docker griddog
  EOF
}

# ---------------------------------------------------------------------------
# griddog-nginx (public subnet — nginx reverse proxy)
# ---------------------------------------------------------------------------
resource "aws_instance" "nginx" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.micro"
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.nginx.id]
  key_name                    = var.key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true
  user_data                   = local.user_data
  user_data_replace_on_change = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    delete_on_termination = true
  }

  tags = { Name = "griddog-nginx" }
}

# ---------------------------------------------------------------------------
# griddog-frontend (private subnet — Next.js + Puppeteer)
# ---------------------------------------------------------------------------
resource "aws_instance" "frontend" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.private.id
  vpc_security_group_ids      = [aws_security_group.frontend.id]
  key_name                    = var.key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  user_data                   = local.user_data
  user_data_replace_on_change = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
  }

  tags = { Name = "griddog-frontend" }
}

# ---------------------------------------------------------------------------
# griddog-app (private subnet — Go + Java + Express, --network=host)
# ---------------------------------------------------------------------------
resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.private.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  key_name                    = var.key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  user_data                   = local.user_data
  user_data_replace_on_change = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
  }

  tags = { Name = "griddog-app" }
}

# ---------------------------------------------------------------------------
# griddog-databases (private subnet — PostgreSQL + MongoDB)
# Two additional EBS volumes for data persistence
# ---------------------------------------------------------------------------
resource "aws_instance" "databases" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.private.id
  vpc_security_group_ids      = [aws_security_group.databases.id]
  key_name                    = var.key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  user_data                   = local.user_data
  user_data_replace_on_change = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
  }

  tags = { Name = "griddog-databases" }
}

# EBS volume for Postgres data (/data/postgres)
resource "aws_ebs_volume" "postgres" {
  availability_zone = var.availability_zone
  size              = 8
  type              = "gp3"

  tags = { Name = "griddog-postgres-data" }
}

resource "aws_volume_attachment" "postgres" {
  device_name  = "/dev/xvdf"
  volume_id    = aws_ebs_volume.postgres.id
  instance_id  = aws_instance.databases.id
  force_detach = false
}

# EBS volume for MongoDB data (/data/mongodb)
resource "aws_ebs_volume" "mongodb" {
  availability_zone = var.availability_zone
  size              = 8
  type              = "gp3"

  tags = { Name = "griddog-mongodb-data" }
}

resource "aws_volume_attachment" "mongodb" {
  device_name  = "/dev/xvdg"
  volume_id    = aws_ebs_volume.mongodb.id
  instance_id  = aws_instance.databases.id
  force_detach = false
}
