output "app_url" {
  description = "Application URL via ALB (HTTP)"
  value       = "http://${aws_lb.main.dns_name}"
}

output "alb_dns_name" {
  description = "Raw ALB DNS name"
  value       = aws_lb.main.dns_name
}

output "nginx_public_ip" {
  description = "nginx EC2 public IP (direct access)"
  value       = aws_instance.nginx.public_ip
}

output "private_ips" {
  description = "Private IPs of each EC2"
  value = {
    nginx     = aws_instance.nginx.private_ip
    frontend  = aws_instance.frontend.private_ip
    app       = aws_instance.app.private_ip
    databases = aws_instance.databases.private_ip
  }
}

output "ssh_commands" {
  description = "SSH commands (nginx is the bastion for private instances)"
  value = {
    nginx     = "ssh -i ~/.ssh/${var.key_name}.pem ubuntu@${aws_instance.nginx.public_ip}"
    frontend  = "ssh -i ~/.ssh/${var.key_name}.pem -J ubuntu@${aws_instance.nginx.public_ip} ubuntu@${aws_instance.frontend.private_ip}"
    app       = "ssh -i ~/.ssh/${var.key_name}.pem -J ubuntu@${aws_instance.nginx.public_ip} ubuntu@${aws_instance.app.private_ip}"
    databases = "ssh -i ~/.ssh/${var.key_name}.pem -J ubuntu@${aws_instance.nginx.public_ip} ubuntu@${aws_instance.databases.private_ip}"
  }
}

output "ssm_parameter_arns" {
  description = "SSM parameter ARNs"
  value = {
    db_password     = aws_ssm_parameter.db_password.arn
    datadog_api_key = aws_ssm_parameter.dd_api_key.arn
  }
}
