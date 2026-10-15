# FD-7 slice 1: the API image registry. NOT APPLIED. Off by default (same switch as the rest of API hosting: enable_api_hosting).
# Until now `api_image` was validated as an ECR digest reference and the task execution roles were granted pull on that repository, but nothing
# created the repository, so there was nowhere to push. This is that repository and nothing else: no replication, no pull-through cache, no
# repository policy (the execution roles' own pull grant, api-compute.tf and worker.tf, is the only access besides the person who pushes).
# Order of use: apply the foundations, push the image (docs/ops/image-push.md), then set `api_image` to the digest and apply again.

resource "aws_ecr_repository" "api" {
  count = local.api_count
  name  = "${local.name}-api"

  # A tag can never be moved to different content, so a deployment is exactly one reviewed artifact (api_image is pinned by digest anyway).
  image_tag_mutability = "IMMUTABLE"

  # Only the synthetic rehearsal may delete a repository that still holds images, so a destroy works there. Production keeps them.
  force_delete = local.synthetic

  image_scanning_configuration {
    scan_on_push = true
  }

  # The AWS-managed key. A customer-managed key would also need decrypt grants on both execution roles; the images hold code, not records.
  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep the most recent images so the registry does not grow without bound; a rollback target is always within the last ten.
resource "aws_ecr_lifecycle_policy" "api" {
  count      = local.api_count
  repository = aws_ecr_repository.api[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

output "api_repository_url" {
  description = "Where the API image is pushed (docs/ops/image-push.md): <account>.dkr.ecr.<region>.amazonaws.com/<name>. Null while API hosting is off."
  value       = one(aws_ecr_repository.api[*].repository_url)
}
