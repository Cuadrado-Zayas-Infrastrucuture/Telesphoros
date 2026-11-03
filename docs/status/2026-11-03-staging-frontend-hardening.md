# Staging frontend workflow: no identifiers in the repository, no token during installs

Date: 2026-11-03

Review of #268 found three problems on main. The workflow and IAM files held the AWS account id, the web bucket and the distribution id, in a public repository that #86 had cleaned of the account id. One job installed dependencies and built with `id-token: write`, so any install or build script could have requested the AWS-assumable token. The trust policy pinned the repository by name and the environment only.

The workflow is now two jobs. `build` installs, builds and packs the bundle with no OIDC permission and reports the archive's SHA-256; `publish` holds `id-token: write`, runs no package manager, and asks AWS for credentials only after the downloaded archive matches that digest. The identifiers come from repository variables; the IAM files are templates; the trust adds `repository_id`, `repository_owner_id` and this workflow's `job_workflow_ref`. A new supply-chain rule refuses, in every workflow, a job that holds `id-token` and installs packages, and any 12-digit account id. The guide now says activation is blocked in the current staging account, whose AWS-managed SCP denies `iam:*Provider*`.

Not changed: the account id remains in #268's commits (only a history rewrite removes it); repository variables still appear in public job logs; the role is still created by hand, outside Terraform. No AWS change, activation or run was made.
