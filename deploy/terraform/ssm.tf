# ---------------------------------------------------------------------------
# SSM Parameter Store — secrets injected into containers at startup
# Retrieve on EC2: aws ssm get-parameter --name /griddog/sg/db_password --with-decryption
# ---------------------------------------------------------------------------
resource "aws_ssm_parameter" "db_password" {
  name        = "/griddog/sg/db_password"
  description = "GridDog PostgreSQL and MongoDB password"
  type        = "SecureString"
  value       = var.db_password

  tags = { Name = "griddog-db-password" }
}

resource "aws_ssm_parameter" "dd_api_key" {
  name        = "/griddog/sg/dd_api_key"
  description = "Datadog API key"
  type        = "SecureString"
  value       = var.datadog_api_key

  tags = { Name = "griddog-dd-api-key" }
}

# ---------------------------------------------------------------------------
# IAM role + instance profile — lets EC2s read their own SSM parameters
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "griddog-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = { Name = "griddog-ec2-role" }
}

data "aws_iam_policy_document" "ssm_read" {
  statement {
    sid     = "ReadGriddogParams"
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.db_password.arn,
      aws_ssm_parameter.dd_api_key.arn,
    ]
  }

  statement {
    sid       = "DecryptSSM"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:${var.aws_region}:*:alias/aws/ssm"]
  }
}

resource "aws_iam_role_policy" "ssm_read" {
  name   = "griddog-ssm-read"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ssm_read.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "griddog-ec2-profile"
  role = aws_iam_role.ec2.name
}
