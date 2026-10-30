# Releasing the API image (FD-7, INF-03)

**Status: written and tested offline, not applied.** The registry (`registry.tf`), the signing key and the CI release role (`signing.tf`) are Terraform. The
`release-image` job in `ci.yml` is skipped until the founder turns it on ([ci-cd.md](ci-cd.md)). None of these steps has been run against a real account.
Nothing here approves an apply: the gates in `infrastructure/terraform/README.md` and the plan in
[../design/plans/fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md) still hold. Synthetic data only. Design:
`specs/002-signed-image-release`.

## What exists

With `enable_api_hosting = true` the root creates one ECR repository, `<name_prefix>-<environment>-api` (for example `telesphoros-staging-api`), and its lifecycle policy. Nothing else:
no repository policy, no replication, no pull-through cache. The task **execution roles** may pull only the one repository named in `api_image`
([api-hosting.md](api-hosting.md)). The release role may push to it (below). The output `api_repository_url` is its address (null while hosting is off).

| Setting | Value | Why |
| --- | --- | --- |
| Tags | **immutable** | A tag can never be moved to different content. Every push needs a new tag. |
| Scan | on push | Findings are visible in the registry; the CI `image` job remains the release gate (fixed HIGH/CRITICAL, no exemptions). The account's registry scan rule (`registry.tf`) is what makes this happen: a registry setting with no rules overrides the repository's own scan on push. |
| Encryption | AES-256, AWS-managed key | Decision recorded in the FD-7 plan. The image holds code, not records. A customer-managed key would first need decrypt grants on both execution roles. |
| Retention | the last 10 **tagged** images | Older images expire. Signatures are untagged OCI referrers and are not counted. A rollback target is always within the last ten, but **do not rely on an old digest staying pullable**. |
| Deleting the repository | **synthetic profile only** (`force_delete = local.synthetic`) | A synthetic destroy works with images in it. In production AWS refuses to delete a repository that still holds images. |

## How an image gets to ECR: CI pushes and signs

On every pull request and push, the `image` job builds **one** OCI archive (the image index with its SBOM and provenance), scans that archive's own
linux/amd64 image with Trivy and rehearses it. On a push to `main`, `release-image` then:

1. downloads that same archive and checks its digest (no rebuild);
2. pushes it under the tag `git-<first 12 characters of the commit>`, and checks that ECR kept the digest;
3. signs the digest with the stack's KMS key `alias/<name_prefix>-<environment>-image-signing` (cosign, no public transparency log), and verifies the signature.

The job summary prints the line to use: `api_image = "<repository url>@sha256:<digest>"`. That digest is the **index** digest: what was scanned,
pushed, signed and deployed.

### Cloud credentials in CI: the one exception

CI stores no cloud secret. The one job that reaches AWS is `release-image`, which holds the repository's only write permission (`id-token: write`). On a push
to `main`, in the `image-release` environment, it exchanges GitHub's OIDC token for the role `<name_prefix>-<environment>-ci-image-release` for at most
one hour (`max_session_duration = 3600`). The trust policy accepts only this repository's `ci.yml`, on `main`, in that environment. The role may:

- `ecr:GetAuthorizationToken` (AWS allows no narrower resource);
- on the one API repository only: `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`,
  `BatchGetImage`, `GetDownloadUrlForLayer`, `DescribeImages`;
- on the signing key only: `kms:Sign`, `kms:GetPublicKey`, `kms:DescribeKey`.

Nothing else. The key policy also **denies** `kms:Sign` to every other principal, so an IAM policy added later cannot create a second signer.

## Before setting `api_image`: verify the signature

`check-plan.mjs` stage C refuses a plan unless `verified-image.json` sits next to the saved plan and covers every image the plan deploys. Write it
from the repository root, with AWS credentials for the stack's account and cosign 3 (CI pins v3.1.3, `infrastructure/docker/release-tools.sh`):

```sh
export AWS_REGION=<region>
REPO_URL=$(terraform -chdir=infrastructure/terraform output -raw api_repository_url)
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPO_URL%%/*}"

# api_image, and api_migrate_image too when the plan sets it: name every image in ONE run, because each run replaces the record.
node scripts/staging/verify-image.mjs --name-prefix <name_prefix> --environment <environment> "$REPO_URL@sha256:<digest>"
```

For each image it runs `cosign verify --key awskms:///<key ARN> --insecure-ignore-tlog <image>` and checks that every signed payload names that
digest. The key ARN comes from `aws kms describe-key` on the stack's alias, and the key must be an enabled `ECC_NIST_P256` / `SIGN_VERIFY` key in the
image's account and Region. Only if every image passes does it write `infrastructure/terraform/.terraform/verified-image.json` (`--record` to
change that). The record holds the images, the key alias and ARN, the cosign version and the time. A failure leaves an earlier record untouched.
Your identity needs `kms:DescribeKey` and `kms:GetPublicKey` on the key. The key policy delegates those to IAM, so account administrators have them.

Then plan and check as usual ([staging-plan-review.md](staging-plan-review.md)):
`node scripts/staging/check-plan.mjs C infrastructure/terraform/.terraform/c.plan.json`. Stage C refuses:

- no record;
- a record of another format;
- one for another environment;
- one verified with another stack's key alias;
- one whose key ARN is outside the stack's account or Region;
- one that does not list `api_image`, or `api_migrate_image` when that is set.

**What the record is, and is not.** It is a local file. It proves that this check ran on these digests, not that nobody edited it afterwards. It catches a skipped or mistaken
verification. It does not stop a person who can apply Terraform: that person can skip `check-plan` altogether. ECS does not check signatures. The record
has no expiry. After a key rotation, verify again with the new key.

### Verifying without KMS access

The public key is not secret. Anyone can export it once and verify with plain cosign:

```sh
aws kms get-public-key --region "$AWS_REGION" --key-id alias/<name_prefix>-<environment>-image-signing --query PublicKey --output text | base64 --decode > image-signing.der
openssl pkey -pubin -inform DER -in image-signing.der -out image-signing.pub
cosign verify --key image-signing.pub --insecure-ignore-tlog "$REPO_URL@sha256:<digest>"
```

## Break-glass: a manual push, synthetic staging only

When CI cannot release (Actions down, the job broken) and a synthetic staging change cannot wait, a person can still push by hand. **Never for
production** (decision D3): there, fix or wait for CI. `verify-image.mjs` refuses `--environment production`, and `check-plan.mjs` refuses a break-glass
record in a production plan.

Run from a clean checkout of the reviewed commit, with AWS credentials that may push to the repository. Docker 24 or newer, and AWS CLI v2:

```sh
export AWS_REGION=<region>
REPO_URL=$(terraform -chdir=infrastructure/terraform output -raw api_repository_url)   # <account>.dkr.ecr.<region>.amazonaws.com/<name>-api
REPO_NAME=${REPO_URL#*/}

test -z "$(git status --porcelain)" || { echo "dirty checkout: build from a clean commit"; exit 1; }
TAG=manual-$(git rev-parse --short=12 HEAD)                   # unique per commit (tags are immutable); never git-<sha>, which CI uses

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPO_URL%%/*}"
docker buildx build --platform linux/amd64 --load -f infrastructure/docker/api.Dockerfile -t "$REPO_URL:$TAG" .
node infrastructure/docker/rehearsal.cjs "$REPO_URL:$TAG"     # the same synthetic rehearsal CI runs
docker push "$REPO_URL:$TAG"

# The registry's own record of the digest (what a task will pull). Do not copy it from build output.
DIGEST=$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$REPO_NAME" --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text)

node scripts/staging/verify-image.mjs --name-prefix <name_prefix> --environment staging \
  --unsigned-break-glass "<one line: why CI could not release, and what this image fixes>" "$REPO_URL@$DIGEST"
```

The record says `break-glass`, holds the reason, and checks no signature. `verify-image.mjs` prints `BREAK-GLASS: UNSIGNED IMAGE` with the reason,
and `check-plan.mjs` prints it again when it accepts stage C. The reason must be one line of 10 to 300 characters. Write no names, patients or other personal data in it.
Record the exception where the ruleset break-glass is recorded ([ci-cd.md](ci-cd.md), "Break-glass"). Once CI is back, release the same commit
through CI and switch `api_image` to the signed digest.

The image must be **linux/amd64**: both task definitions declare `X86_64`. An image built for another architecture starts and exits at once.

## Check the scan

```sh
aws ecr describe-image-scan-findings --region "$AWS_REGION" --repository-name "$REPO_NAME" --image-id imageDigest="$DIGEST" --query 'imageScanFindings.findingSeverityCounts'
```

The scan is basic registry scanning and is a second look, not the gate. Do not set `api_image` for an image whose CI `image` run was not green on the same commit.

## What this does not prove

Not verified until a real account exists (tasks T019–T021):

- that cosign's KMS signer works with an `ECC_NIST_P256` key (A2);
- that ECR stores the signature as a referrer (A3);
- that the OIDC trust conditions match GitHub's real token (A1);
- that Fargate runs an index that carries attestation manifests;
- that the execution roles can pull the pushed digest;
- that the lifecycle rule expires as intended;
- the registry's cost: up to ten images are stored, and no estimate has been made.

`verify-image.mjs` was checked against stand-in `cosign` and `aws`. A real cosign v3.1.3 was run with a file key on a local registry, which matches the stand-ins.
It has not been run against KMS.
