# Deployment (design only)

**Nothing is deployed from this repository, and no workflow can deploy.** There is deliberately no deploy workflow:
Terraform has never been applied, no AWS account is wired to GitHub, the AWS BAA is not executed, and the hosting
choice below is open. This page records the intended flow so the workflow can be written once those are settled.

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
| Frontend hosting: Vercel, or S3 + CloudFront | open (founder) |
| AWS BAA executed | deferred; **no real patient data until it is** |
| Remote Terraform state backend and the OIDC roles | not created |
| DNS location for the domain | open |
| Backups on a different provider than the database | not met: see the backup requirement in [../database.md](../database.md) |

Until then, CI ([ci-cd.md](ci-cd.md)) validates the Terraform text and nothing more.
