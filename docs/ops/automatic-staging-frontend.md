# Automatic staging frontend publication

The `staging-frontend` workflow publishes the normal production frontend after
successful `ci` push runs on main. PR, fork, failed and stale runs cannot publish.
Existing required checks and CI reuse rules remain unchanged. Releases serialize
without cancelling an upload, and main is checked again just before publishing.
A merge during an upload can temporarily leave that successful older build live;
the next successful current-main run replaces it. Failed CI never publishes.

It runs as two jobs. `build` installs the dependencies, builds and validates the
bundle, and packs it into one archive with its SHA-256; it has no OIDC permission,
so no install or build script can request the AWS-assumable token. `publish` holds
`id-token: write`, runs no package manager, checks that the downloaded archive has
the digest `build` reported, and only then asks AWS for credentials.

It uses the existing publisher: assets first, index last, no source maps or
removal of old assets. One CloudFront invalidation is awaited, then the public
`release.json` commit must match. The Actions summary records the released SHA.
An upload or verification failure is a failed deployment job, never silent success.
No backend image, migration, Cognito configuration or Terraform apply is included.
Frontend releases still need compatible backend APIs; these checks do not deploy
or certify new server features.

## Blocked in the current staging account

The staging account's AWS-managed project service control policy denies
`iam:*Provider*`, so no GitHub OIDC provider can be created or even listed there,
and nobody can grant an exception: AWS publishes that policy as unmodifiable, and
its Paid Plan version carries the same deny. `get-open-id-connect-provider`
answers **AccessDenied**, not `NoSuchEntity`. The setup below applies only in an
account where that call is allowed. Until then, publish with
`scripts/staging/publish-frontend.sh` from a person's shell
([frontend-publish.md](frontend-publish.md)).

## One-time activation

This source change does not create AWS resources or enable publication. The
workflow is dormant unless repository variable `STAGING_FRONTEND_AUTO_DEPLOY`
is exactly `true`. Do not enable it until the following setup is complete.

No account id, bucket or distribution id is written in this repository: it is
public. They live in repository variables, and the IAM files are templates.

1. In GitHub, create environment `staging-frontend`. Under deployment branches,
   choose **Selected branches and tags**, add branch `main` only, and no tags.
   For automatic publication, do not add a required reviewer or wait timer.
2. Confirm the account allows a GitHub OIDC provider (see above). Do not substitute
   long-lived access keys or use the full-access role in CI.
3. If absent, create IAM OIDC provider `https://token.actions.githubusercontent.com`
   with audience `sts.amazonaws.com`. Reuse an existing provider; do not replace it.
4. Fill the templates in a private directory, never in the checkout:
   `scripts/staging/iam/frontend-trust.json` needs `<account>`, `<repository_id>`
   and `<repository_owner_id>` (`gh api repos/<owner>/<name> --jq '.id, .owner.id'`);
   `scripts/staging/iam/frontend-permissions.json` needs `<account>`, `<web_bucket>`
   and `<distribution_id>` (Terraform outputs `web_bucket` and `web_distribution_id`).
   The trust accepts only this repository and owner by immutable id, the
   `staging-frontend` environment, and this workflow file on `main`
   (`job_workflow_ref`; check what GitHub sends for a `workflow_run` job on the first
   run, in CloudTrail `AssumeRoleWithWebIdentity`: a mismatch fails closed). The
   policy grants no delete, API, database, report-bucket, IAM, Terraform or KMS
   permission; if bucket encryption has changed to a customer-managed key, stop and
   review that prerequisite rather than broadening the policy.
5. Create role `telesphoros-staging-frontend-publisher` with the filled trust and
   attach the filled policy as an inline policy.
6. Set repository variables `STAGING_FRONTEND_ACCOUNT_ID`, `STAGING_FRONTEND_WEB_BUCKET`,
   `STAGING_FRONTEND_DISTRIBUTION_ID` and `STAGING_FRONTEND_ROLE_ARN`. Set
   `STAGING_FRONTEND_AUTO_DEPLOY` to `true` last.
7. After activation, a successful main push CI run triggers publication. If that
   run finished before activation, rerun the latest main **ci** run (not a PR run).
   The workflow rejects it if main has advanced; wait for current main's successful
   CI instead. Check the `staging-frontend` Actions run and
   `https://app.staging.telesphoros.app/release.json` for the expected commit.

Repository variables are not secrets: in a public repository their values appear in
the job logs (the step environment and the publisher's output). Keeping them out of
the files keeps them out of history and code search; it does not hide them from the
logs. The workflow guards forbid `secrets.` by design, so hiding them there too is a
separate decision.

Stop on errors. If the role already exists, inspect its trust and policies instead
of replacing it blindly. No live setup or OIDC exchange was performed by the
source change; first-run acceptance remains necessary.

## Disable and recover

Set `STAGING_FRONTEND_AUTO_DEPLOY` to `false` to stop future deployments. This does
not cancel one already uploading. For an urgent freeze, also revoke the role's
publish policy, allowing any partial release to be inspected before recovery.
The existing manual publisher remains available. Roll back only with a reviewed,
compatible prior checkout and its matching built bundle/settings; keep old hashed
assets. An old CI rerun cannot roll back main because the current-main guard refuses
it. Do not delete the bucket or disable checks to recover.
