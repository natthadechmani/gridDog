# ---------------------------------------------------------------------------
# ECR repos — one per service.
# Lifecycle: keep last 10 untagged images to limit storage cost.
# ---------------------------------------------------------------------------

locals {
  ecr_repos = [
    "griddog/backend",
    "griddog/java-service",
    "griddog/express-service",
    "griddog/dotnet-scheduler",
    "griddog/frontend",
    "griddog/traffic",
  ]
}

resource "aws_ecr_repository" "services" {
  for_each = toset(local.ecr_repos)

  name                 = each.value
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Project = "griddog"
    Stack   = "eks"
  }
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}
