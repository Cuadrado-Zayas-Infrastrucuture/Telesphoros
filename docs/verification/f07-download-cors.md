# F07 publication preparation — 2026-10-16

Candidate branch `fix/f07-download-cors-publication` starts from main `6f2ddaafcebda9a5947dd8831b586c4119f9057b`, after F06 PR #131 and documentation-only PR #132. F07 runtime, launcher parity and permanent origin probes are ported from `a4ca244`; the browser bridge is the storage-spec portion of `60f1795`. Both source integration branches, the combined reference and the published F06 checkout are preserved.

## Scope and invariant checks

Terraform and all three local consumers share the GET-only contract, exact deployment/loopback origins, Content-Type allowance, ETag exposure and 300-second preflight cache. Native launcher expectations remain literal and independent of the shared JSON. Child Moto environments disable the global fallback; worker handoff, restricted credentials, staging controls and final version-pin ordering remain intact. No API, auth, recovery, roles, intake, IAM, clinical, retention or versioning behavior is changed.

All **38 promoted probes** are permanent: 25 local cases (three canonical origins, 21 refusals, returned-array isolation) within the 30-case CORS suite; 13 native Terraform cases (11 refusals and two exact HTTPS successes) within 33 mocked plans. The 19 merged F06 probes are retained separately. The real-storage bridge is additional browser coverage, not a 39th promoted origin probe: desktop/mobile reload and same-caller reauthentication retain registration, declaration, attempt and original timestamp; one committed version downloads with exact bytes, size and SHA-256. It refuses direct storage PUT and credential/referrer leakage, and checks storage identity after download.

## Verification plan and evidence boundaries

Freeze the candidate before verification. Record full permitted producer logs, commands, exit codes, actual counts/skips, source/build hashes and task-owned service cleanup in the external `f07-publication-verification` receipt. Run:

- All 30 local CORS guards, aggregate infrastructure/CI/workspace guards, Terraform format/validate and all 33 mocked plans (backend disabled, lockfile read-only; no apply).
- All five independent native Moto/Chromium launcher controls, including older-review GET parity, retired PUT refusal, paired excluded/allowed origin, policy readback/restore, child fallback isolation and worker handoff.
- Full frontend and branding/preview tests; focused F06/auth/recovery/download tests with all 19 probes; shared contracts; workspace build, typecheck and lint; operations controls.
- Focused API/controller tests in memory and real PostgreSQL/S3 profiles, plus authority/membership checks with a restricted application login on a fresh synthetic cluster.
- Matching built UI/API storage browsers on desktop/mobile with the bridge and version-pin last; enabled recovery/navigation and default auth profiles; genuine old/new UI/API compatibility pairs.

Earlier F07 and combined receipts concern their original commits and are not passes on this new candidate. Fresh results, exact frozen hash, failures and cleanup are recorded externally after execution so documentation does not alter the verified head. Browser totals are executions, not unique cases; focused and standalone subsets are not added twice. Local mock/Moto evidence does not establish hosted AWS/Cognito/RDS/S3/CDN acceptance or remote required CI. No push, PR, merge, Terraform apply or deployment is authorized by this preparation.
