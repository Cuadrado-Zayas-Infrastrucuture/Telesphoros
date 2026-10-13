# Deployment (design only)

**Nothing is deployed from this repository, and no workflow can deploy.** There is deliberately no deploy workflow:
Terraform has never been applied, no AWS account is wired to GitHub, the AWS BAA is not executed, and the hosting
choice below is settled but not deployed. This page records the intended flow so the workflow can be written once the remaining prerequisites are settled.

## Intended flow (to be built after the decisions below)

1. **No long-lived cloud keys.** GitHub Actions assumes an AWS IAM role through OpenID Connect. The role's trust policy
   names this repository and the specific environment, and nothing else.
2. **Plan on every pull request** that touches `infrastructure/terraform/`, with a read-only role. The plan is posted as
   a PR check; it never applies.
3. **Apply only from `main`, only after a person approves** it in a protected GitHub *environment* (required reviewer).
   The apply role is a different, narrower role than the plan role. State lives in a remote S3 backend with locking and
   encryption, which does not exist yet (`versions.tf` says so).
4. **Application release** is a separate, later workflow that deploys a built artifact and runs the migrations
   (`db:migrate`) as the migrator role, never as the API's role.
5. **Plans and apply output are kept only when a run fails**, for 7 days, and never contain secret values.

## Decisions that must come first

| Decision | State |
| --- | --- |
| Frontend hosting | Founder chose company site on Vercel, product on S3 + CloudFront; H1 configuration is disabled by default, not applied |
| AWS BAA executed | deferred; **no real patient data until it is** |
| Remote Terraform state backend and the OIDC roles | not created |
| DNS location for both domains | Jan's single Cloudflare account, administered by Jan; Google email records preserved |
| Backups on a different provider than the database | not met: see the backup requirement in [../database.md](../database.md) |

Until then, CI ([ci-cd.md](ci-cd.md)) validates the Terraform text and nothing more.

The [H1 hosting and DNS checklist](domains-and-hosting.md) describes the optional frontend resources,
manual certificate validation, staged checks and rollback. API hosting is F3: the edge (F3a) is written ([api-hosting.md](api-hosting.md)); the compute (F3b) is written too. The API image is built, scanned and rehearsed by the required `image` CI job ([image runbook](../../infrastructure/docker/README.md)) but never published; the deployment pipeline (F4) is not written. No Vercel project
has been inspected; the company site's source/project is still needed.
