# Automatic staging frontend publisher
Date: 2026-11-03

Added a separate, opt-in GitHub workflow for the observed synthetic AWS staging
frontend. Successful same-repository push CI for current main can publish through
a dedicated OIDC role. Serialized uploads, a second main check, map exclusion,
CloudFront completion and a served-commit check protect publication. A public
release.json identifies the build. Existing required checks are unchanged.

The setup guide includes pinned IAM trust/permissions, main-only environment
restrictions and the documented organization SCP blocker. No credentials, AWS
operations, backend deployment or live activation occur in this source change.
Exact validation and remaining live acceptance are recorded in the PR.
