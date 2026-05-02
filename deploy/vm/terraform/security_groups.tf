# ---------------------------------------------------------------------------
# Security Groups — defined empty first to break circular references,
# then rules are added separately via aws_security_group_rule
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "griddog-ec2-alb"
  description = "ALB: HTTP from internet, egress to nginx"
  vpc_id      = data.aws_vpc.main.id
  tags        = { Name = "griddog-ec2-alb" }
}

resource "aws_security_group" "nginx" {
  name        = "griddog-ec2-nginx"
  description = "nginx: SSH from admin, HTTP from ALB, egress to frontend/app"
  vpc_id      = data.aws_vpc.main.id
  tags        = { Name = "griddog-ec2-nginx" }
}

resource "aws_security_group" "frontend" {
  name        = "griddog-ec2-frontend"
  description = "Frontend: SSH from bastion/admin, Next.js from nginx"
  vpc_id      = data.aws_vpc.main.id
  tags        = { Name = "griddog-ec2-frontend" }
}

resource "aws_security_group" "app" {
  name        = "griddog-ec2-app"
  description = "App: SSH from bastion/admin, Go :8080 from nginx/frontend"
  vpc_id      = data.aws_vpc.main.id
  tags        = { Name = "griddog-ec2-app" }
}

resource "aws_security_group" "databases" {
  name        = "griddog-ec2-databases"
  description = "Databases: SSH from bastion/admin, Postgres/Mongo from app"
  vpc_id      = data.aws_vpc.main.id
  tags        = { Name = "griddog-ec2-databases" }
}

# ---------------------------------------------------------------------------
# griddog-ec2-alb rules
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "alb_ingress_http" {
  security_group_id = aws_security_group.alb.id
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = var.alb_allowed_cidrs
  description       = "HTTP from allowed IPs"
}

resource "aws_security_group_rule" "alb_ingress_frontend" {
  security_group_id        = aws_security_group.alb.id
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.frontend.id
  description              = "Puppeteer synthetic traffic from frontend EC2"
}

resource "aws_security_group_rule" "alb_ingress_nat" {
  security_group_id = aws_security_group.alb.id
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["${aws_eip.nat.public_ip}/32"]
  description       = "HTTP from NAT gateway EIP (Puppeteer via private subnet)"
}

resource "aws_security_group_rule" "alb_egress_nginx" {
  security_group_id        = aws_security_group.alb.id
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "To nginx EC2"
}

# ---------------------------------------------------------------------------
# griddog-ec2-nginx rules
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "nginx_ingress_ssh" {
  security_group_id = aws_security_group.nginx.id
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [var.admin_cidr]
  description       = "SSH from admin"
}

resource "aws_security_group_rule" "nginx_ingress_http_alb" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
  description              = "HTTP from ALB"
}

resource "aws_security_group_rule" "nginx_egress_frontend" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "egress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.frontend.id
  description              = "To Next.js frontend"
}

resource "aws_security_group_rule" "nginx_egress_app" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "egress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "To Go backend"
}

resource "aws_security_group_rule" "nginx_egress_ssh_frontend" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "egress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.frontend.id
  description              = "SSH to frontend (bastion)"
}

resource "aws_security_group_rule" "nginx_egress_ssh_app" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "egress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "SSH to app (bastion)"
}

resource "aws_security_group_rule" "nginx_egress_ssh_databases" {
  security_group_id        = aws_security_group.nginx.id
  type                     = "egress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.databases.id
  description              = "SSH to databases (bastion)"
}

resource "aws_security_group_rule" "nginx_egress_http" {
  security_group_id = aws_security_group.nginx.id
  type              = "egress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP out (apt package repos)"
}

resource "aws_security_group_rule" "nginx_egress_https" {
  security_group_id = aws_security_group.nginx.id
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTPS out (package installs)"
}

# ---------------------------------------------------------------------------
# griddog-ec2-frontend rules
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "frontend_ingress_ssh_bastion" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "ingress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "SSH via nginx bastion"
}

resource "aws_security_group_rule" "frontend_ingress_ssh_admin" {
  security_group_id = aws_security_group.frontend.id
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [var.admin_cidr]
  description       = "SSH direct from admin"
}

resource "aws_security_group_rule" "frontend_ingress_nextjs" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "Next.js from nginx"
}

resource "aws_security_group_rule" "frontend_egress_nginx" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "Puppeteer synthetic traffic to nginx"
}

resource "aws_security_group_rule" "frontend_egress_alb" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "egress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
  description              = "Puppeteer synthetic traffic via ALB"
}

resource "aws_security_group_rule" "frontend_ingress_traffic_control" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "ingress"
  from_port                = 3002
  to_port                  = 3002
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "Traffic control API from backend"
}

resource "aws_security_group_rule" "app_egress_traffic_control" {
  security_group_id        = aws_security_group.app.id
  type                     = "egress"
  from_port                = 3002
  to_port                  = 3002
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.frontend.id
  description              = "Traffic control API to frontend"
}

resource "aws_security_group_rule" "frontend_egress_app" {
  security_group_id        = aws_security_group.frontend.id
  type                     = "egress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "Next.js server-side to Go backend"
}

resource "aws_security_group_rule" "frontend_egress_http" {
  security_group_id = aws_security_group.frontend.id
  type              = "egress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP out (apt package repos)"
}

resource "aws_security_group_rule" "frontend_egress_https" {
  security_group_id = aws_security_group.frontend.id
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTPS out (npm, package installs)"
}

# ---------------------------------------------------------------------------
# griddog-ec2-app rules
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "app_ingress_ssh_bastion" {
  security_group_id        = aws_security_group.app.id
  type                     = "ingress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "SSH via nginx bastion"
}

resource "aws_security_group_rule" "app_ingress_ssh_admin" {
  security_group_id = aws_security_group.app.id
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [var.admin_cidr]
  description       = "SSH direct from admin"
}

resource "aws_security_group_rule" "app_ingress_go_nginx" {
  security_group_id        = aws_security_group.app.id
  type                     = "ingress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "Go backend from nginx"
}

resource "aws_security_group_rule" "app_ingress_go_frontend" {
  security_group_id        = aws_security_group.app.id
  type                     = "ingress"
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.frontend.id
  description              = "Go backend from frontend"
}

resource "aws_security_group_rule" "app_egress_postgres" {
  security_group_id        = aws_security_group.app.id
  type                     = "egress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.databases.id
  description              = "PostgreSQL"
}

resource "aws_security_group_rule" "app_egress_mongodb" {
  security_group_id        = aws_security_group.app.id
  type                     = "egress"
  from_port                = 27017
  to_port                  = 27017
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.databases.id
  description              = "MongoDB"
}

resource "aws_security_group_rule" "app_egress_http" {
  security_group_id = aws_security_group.app.id
  type              = "egress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP out (apt package repos)"
}

resource "aws_security_group_rule" "app_egress_https" {
  security_group_id = aws_security_group.app.id
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTPS out (package installs, SSM)"
}

# ---------------------------------------------------------------------------
# griddog-ec2-databases rules
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "databases_ingress_ssh_bastion" {
  security_group_id        = aws_security_group.databases.id
  type                     = "ingress"
  from_port                = 22
  to_port                  = 22
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.nginx.id
  description              = "SSH via nginx bastion"
}

resource "aws_security_group_rule" "databases_ingress_ssh_admin" {
  security_group_id = aws_security_group.databases.id
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [var.admin_cidr]
  description       = "SSH direct from admin"
}

resource "aws_security_group_rule" "databases_ingress_postgres" {
  security_group_id        = aws_security_group.databases.id
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "PostgreSQL from app"
}

resource "aws_security_group_rule" "databases_ingress_mongodb" {
  security_group_id        = aws_security_group.databases.id
  type                     = "ingress"
  from_port                = 27017
  to_port                  = 27017
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  description              = "MongoDB from app"
}

resource "aws_security_group_rule" "databases_egress_http" {
  security_group_id = aws_security_group.databases.id
  type              = "egress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP out (apt package repos)"
}

resource "aws_security_group_rule" "databases_egress_https" {
  security_group_id = aws_security_group.databases.id
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTPS out (package installs, SSM)"
}
