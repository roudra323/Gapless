# One image repository per app (docs/07). CI pushes images tagged with the git SHA, which never
# change, so tags are immutable.
locals {
  apps = toset(["indexer", "api"])
}

resource "aws_ecr_repository" "app" {
  for_each = local.apps

  name                 = "gapless-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  # A learning environment: `terraform destroy` must work even when images are left.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep the last 20 images; older ones are deleted automatically.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
