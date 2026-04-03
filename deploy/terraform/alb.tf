# ---------------------------------------------------------------------------
# Application Load Balancer
# Spans both public subnets (AWS requires min 2 AZs)
# ---------------------------------------------------------------------------
resource "aws_lb" "main" {
  name               = "griddog-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public.id, aws_subnet.public_secondary.id]

  tags = { Name = "griddog-alb" }
}

# ---------------------------------------------------------------------------
# Target group — forwards to nginx EC2 on port 80
# ---------------------------------------------------------------------------
resource "aws_lb_target_group" "nginx" {
  name     = "griddog-nginx-tg"
  port     = 80
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.main.id

  health_check {
    path                = "/nginx-health"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }

  tags = { Name = "griddog-nginx-tg" }
}

resource "aws_lb_target_group_attachment" "nginx" {
  target_group_arn = aws_lb_target_group.nginx.arn
  target_id        = aws_instance.nginx.id
  port             = 80
}

# ---------------------------------------------------------------------------
# HTTP listener — forwards to nginx (add HTTPS later when domain is ready)
# ---------------------------------------------------------------------------
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.nginx.arn
  }
}
