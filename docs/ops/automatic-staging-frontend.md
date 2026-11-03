# Automatic staging frontend publication

The `staging-frontend` workflow publishes the normal production frontend after
successful `ci` push runs on main. PR, fork, failed and stale runs cannot publish.
Existing required checks and CI reuse rules remain unchanged. Releases serialize
without cancelling an upload, and main is checked again just before publishing.
A merge during an upload can temporarily leave that successful older build live;
the next successful current-main run replaces it. Failed CI never publishes.

It uses the existing publisher: assets first, index last, no source maps or
removal of old assets. One CloudFront invalidation is awaited, then the public
`release.json` commit must match. The Actions summary records the released SHA.
An upload or verification failure is a failed deployment job, never silent success.
No backend image, migration, Cognito configuration or Terraform apply is included.
Frontend releases still need compatible backend APIs; these checks do not deploy
or certify new server features.

## One-time activation

This source change does not create AWS resources or enable publication. The
workflow is dormant unless repository variable `STAGING_FRONTEND_AUTO_DEPLOY`
is exactly `true`. Do not enable it until the following setup is complete.

1. In GitHub, create environment `staging-frontend`. Under deployment branches,
   choose **Selected branches and tags**, add branch `main` only, and no tags.
   This restriction is essential: the environment is part of the IAM subject;
   a GitHub environment subject alone does not constrain the branch. For automatic
   publication, do not add a required reviewer or wait timer.
2. In AWS account `403776649274`, inspect the existing GitHub OIDC provider. The
   staging notes report an organization SCP blocking it. Have the organization
   administrator permit the narrowly scoped provider/role setup if still blocked.
   Do not substitute long-lived access keys or use the full-access role in CI.
3. If absent, create IAM OIDC provider `https://token.actions.githubusercontent.com`
   with audience `sts.amazonaws.com`. Reuse an existing provider; do not replace it.
4. Create role `telesphoros-staging-frontend-publisher` with trust from
   `scripts/staging/iam/frontend-trust.json` and attach the inline policy from
   `scripts/staging/iam/frontend-permissions.json`. These files pin the observed
   account, repository environment, web bucket and distribution. They grant no
   delete, API, database, report-bucket, IAM or Terraform permissions. No KMS permissions are granted; if bucket encryption has changed to a customer-managed key, stop and review that prerequisite rather than broadening this policy blindly.
5. Set repository variable `STAGING_FRONTEND_ROLE_ARN` to
   `arn:aws:iam::403776649274:role/telesphoros-staging-frontend-publisher`.
   Set repository variable `STAGING_FRONTEND_AUTO_DEPLOY` to `true` last.
6. After this change merges, a successful main push CI run triggers publication.
   If that run finished before activation, rerun the latest main **ci** run
   (not a PR run). The workflow rejects it if main has advanced; wait for current
   main's successful CI instead. Check the `staging-frontend` Actions run and
   `https://app.staging.telesphoros.app/release.json` for the expected commit.

AWS CLI setup after verifying the correct account and provider, from the repo root:

```sh
aws sts get-caller-identity --profile telesphoros
aws iam get-open-id-connect-provider --profile telesphoros \
  --open-id-connect-provider-arn arn:aws:iam::403776649274:oidc-provider/token.actions.githubusercontent.com
# Only if the provider is absent (NoSuchEntity), and organization policy permits:
# aws iam create-open-id-connect-provider --profile telesphoros \
#   --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com

aws iam create-role --profile telesphoros \
  --role-name telesphoros-staging-frontend-publisher \
  --assume-role-policy-document file://scripts/staging/iam/frontend-trust.json
aws iam put-role-policy --profile telesphoros \
  --role-name telesphoros-staging-frontend-publisher \
  --policy-name publish-staging-frontend \
  --policy-document file://scripts/staging/iam/frontend-permissions.json
```

Stop on errors. If the role already exists, inspect its trust and policies instead
of replacing it blindly. Do not relax an organization policy beyond the approved
provider and dedicated role. No live setup or OIDC exchange was performed by the
source change; first-run acceptance remains necessary.

## Disable and recover

Set `STAGING_FRONTEND_AUTO_DEPLOY` to `false` to stop future deployments. This does
not cancel one already uploading. For an urgent freeze, also revoke the role's
publish policy, allowing any partial release to be inspected before recovery.
The existing manual publisher remains available. Roll back only with a reviewed,
compatible prior checkout and its matching built bundle/settings; keep old hashed
assets. An old CI rerun cannot roll back main because the current-main guard refuses
it. Do not delete the bucket or disable checks to recover.
