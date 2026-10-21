# Pushing the API image (FD-7 slice 1)

**Status: the registry is written as Terraform and tested offline (`registry.tf`). It is not applied. These steps have not been run against a real account.** Nothing here
approves an apply: the gates in `infrastructure/terraform/README.md` and the plan in [../design/plans/fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md) still hold.
Synthetic data only.

## What exists

With `enable_api_hosting = true` the root creates one ECR repository, `<name_prefix>-<environment>-api` (for example `telesphoros-staging-api`), and its lifecycle policy. Nothing else:
no repository policy, no replication, no pull-through cache. The only readers are the task **execution roles**, whose pull grant is limited to the one repository named in `api_image`
([api-hosting.md](api-hosting.md)). The output `api_repository_url` is the address to push to (null while hosting is off).

| Setting | Value | Why |
| --- | --- | --- |
| Tags | **immutable** | A tag can never be moved to different content. Every push needs a new tag. |
| Scan | on push | Findings are visible in the registry; the CI `image` job remains the release gate (fixed HIGH/CRITICAL, no exemptions). |
| Encryption | AES-256, AWS-managed key | Decision recorded in the FD-7 plan. The image holds code, not records. A customer-managed key would first need decrypt grants on both execution roles. |
| Retention | the last 10 images | Older images expire. A rollback target is always within the last ten, but **do not rely on an old digest staying pullable**. |
| Deleting the repository | **synthetic profile only** (`force_delete = local.synthetic`) | A synthetic destroy works with images in it. In production AWS refuses to delete a repository that still holds images. |

## Order of use

1. Apply the foundations with `enable_api_hosting = true` and **no** `api_image` (the task definitions and the service are not created yet).
2. Build and push the image (below). Resolve the **digest**.
3. Set `api_image` to `<repository url>@sha256:<digest>` and apply again. A tag is refused by validation: a deployment is exactly one reviewed artifact.

Pushing before step 1 is impossible (the repository does not exist), and a digest that is not in the registry makes the service fail to start rather than silently run something else.

## Build, push, resolve the digest

Run from a person's shell, on a clean checkout of the reviewed commit, with AWS credentials for the target account. Docker 24 or newer, and AWS CLI v2.

```sh
export AWS_REGION=<region>
cd infrastructure/terraform
REPO_URL=$(terraform output -raw api_repository_url)          # <account>.dkr.ecr.<region>.amazonaws.com/<name>-api
REPO_NAME=${REPO_URL#*/}
cd ../..

test -z "$(git status --porcelain)" || { echo "dirty checkout: build from a clean commit"; exit 1; }
TAG=$(git rev-parse --short=12 HEAD)                          # unique per commit: tags are immutable

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPO_URL%%/*}"

docker buildx build --platform linux/amd64 --load -f infrastructure/docker/api.Dockerfile -t "$REPO_URL:$TAG" .
node infrastructure/docker/rehearsal.cjs "$REPO_URL:$TAG"     # optional: the same synthetic rehearsal CI runs
docker push "$REPO_URL:$TAG"

# The registry's own record of the digest (what a task will pull). Do not copy it from build output.
DIGEST=$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$REPO_NAME" --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text)
echo "api_image = \"$REPO_URL@$DIGEST\""
```

The image must be **linux/amd64**: both task definitions declare `X86_64`. An image built for another architecture starts and exits at once.

Pushing the same tag twice fails (immutable). To push again, build from a new commit, or add a suffix to the tag. A failed push is not a reason to change the registry's setting.

## Check the scan

```sh
aws ecr describe-image-scan-findings --region "$AWS_REGION" --repository-name "$REPO_NAME" --image-id imageTag="$TAG" --query 'imageScanFindings.findingSeverityCounts'
```

The scan is basic registry scanning and is a second look, not the gate. Do not set `api_image` for an image whose CI `image` run was not green on the same commit.

## What this does not prove

Not verified until a real account exists: that the push works from a person's shell, that the execution roles can pull the pushed digest, that the lifecycle rule expires as intended,
and the registry's cost (storage of up to ten images; no estimate has been made). Keyless signing, a CI push identity and an automated deployment are not part of this slice: the push is manual,
by a person, and CI still never holds cloud credentials. (INF-03 adds a CI release job that pushes and signs through a short-lived OIDC role; it is dormant until the founder turns it on, see [ci-cd.md](ci-cd.md). This runbook is rewritten in slice 3 of `specs/002-signed-image-release`.)
