# Report-file recovery planning verification

2026-10-10, baseline main `e550100`, `chore/report-file-recovery-plan`. **Documentation only. No independent-copy recovery test or AWS operation ran.**

## Evidence checked

- Traced report completion → stored hash/version → PostgreSQL repository/migration guard → exact PDF reads/download links. Traced capture text PUT (returned version discarded) → hash/scalar storage → current-object hash checks for links/evaluation. Read actual callers and history, including `d713a5c`, `5a06516` and `b760471`.
- Read ObjectStorage/S3ObjectStorage contracts, exported DB snapshot/format 2 manifest, current recovery fixture and primary-evidence acceptance, Terraform reports bucket/retention/IAM, provider runbooks and project single-Region guidance. No deployment/account eligibility was inferred from written infrastructure.
- Verified #56/#57/#58/#59 are merged via GitHub and refreshed main. #57's published delivery records independent copies/application recovery false. #59's exact-head inspected CI evidence remains in its published PR; this documentation does not reclassify those checks as file-recovery acceptance.
- Checked current primary AWS documentation for replication/version identity and backfill, Object Lock/retention/key limitations, encrypted replication, version-list pagination, security and pricing; citations are adjacent to their claims in the [design](../design/plans/report-file-recovery.md). No legal retention requirement or numeric cost was asserted.

## Scope and validation

Only the new design/verification pages and links/status text in `docs/STATUS.md`, `docs/ops/backup-and-restore.md` and `docs/ops/report-evidence.md` change. Application code, migrations, dependency resolutions, CI, Terraform, AWS resources, deployments, production data and the separate uncommitted workflow setup are unchanged.

Local review checked 81 relative file links across the five changed pages, existing backend build/typecheck/lint/test scripts, the referenced recovery spec/helper paths, the three actual CI profiles and `git diff --check`; all passed. No new tests mirror this documentation. Existing full CI remains a delivery gate; its final-head result and inspected logs are recorded in the PR after completion. Until then this file is the pre-CI snapshot. Future F1–F4 checks are labelled proposed, pending separate approval; no invented CLI/test is presented as available.

## Known limits and next action

The design is concrete for review but the copy catalogue, recovery resolver, scheduling/limits, independent recovery and live permission/Compliance tests do not exist. Primary/current-version hash checks do not make text version-pinned. Native replication and ordinary copy have different VersionId semantics. Region/provider/custody, retention, budget, RPO/RTO and deployment eligibility remain founder gates. Approve a separate local F1 implementation after this planning PR; wider Phase 3/clinical acceptance remains open.
