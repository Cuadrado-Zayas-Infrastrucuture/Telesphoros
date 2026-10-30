# FD-7 slice 1: the API image registry. NOT APPLIED. Off by default (same switch as the rest of API hosting: enable_api_hosting).
# Until now `api_image` was validated as an ECR digest reference and the task execution roles were granted pull on that repository, but nothing
# created the repository, so there was nowhere to push. This is that repository and the scan rule for it, nothing else: no replication, no
# pull-through cache, no repository policy (the execution roles' own pull grant, api-compute.tf and worker.tf, is the only access besides the person who pushes).
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

  lifecycle {
    precondition {
      condition     = (var.github_repository == "") == (var.github_repository_id == "") && (var.github_repository_id == "") == (var.github_repository_owner_id == "")
      error_message = "Set github_repository, github_repository_id and github_repository_owner_id together, or none of them (signing.tf)."
    }
    # INF-03: production must not get a registry whose images nobody signed. The signed release path (signing.tf) needs the repository IDs.
    precondition {
      condition     = var.environment != "production" || local.image_release_count == 1
      error_message = "Production with API hosting requires the signed image release path: set github_repository, github_repository_id and github_repository_owner_id (signing.tf, INF-03)."
    }
  }
}

# Keep the most recent images so the registry does not grow without bound; a rollback target is always within the last ten. Tagged images only (decision D5,
# 2026-10-20): image signatures are untagged OCI 1.1 referrers, which ECR protects while their image exists and expires within 24 hours after it, so
# they must never take one of the ten slots.
resource "aws_ecr_lifecycle_policy" "api" {
  count      = local.api_count
  repository = aws_ecr_repository.api[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 tagged images"
      selection = {
        tagStatus      = "tagged"
        tagPatternList = ["*"]
        countType      = "imageCountMoreThan"
        countNumber    = 10
      }
      action = { type = "expire" }
    }]
  })
}

# The account's registry scanning setting decides what is scanned: once it exists (BASIC with no rules is what this account had), the repository's
# own scan_on_push above is not used, and nothing was scanned (2026-10-30: the first staging image had no scan). This is one setting per account and
# region, so Terraform owns it while API hosting is on; it scans only this stack's repository, on push, with the free basic scanner.
resource "aws_ecr_registry_scanning_configuration" "main" {
  count     = local.api_count
  scan_type = "BASIC"

  rule {
    scan_frequency = "SCAN_ON_PUSH"
    repository_filter {
      filter      = aws_ecr_repository.api[0].name
      filter_type = "WILDCARD"
    }
  }
}

output "api_repository_url" {
  description = "Where the API image is pushed (docs/ops/image-push.md): <account>.dkr.ecr.<region>.amazonaws.com/<name>. Null while API hosting is off."
  value       = one(aws_ecr_repository.api[*].repository_url)
}
