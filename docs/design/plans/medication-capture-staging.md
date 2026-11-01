# Plan: release medication capture to synthetic staging

Date: 2026-11-01. **Draft for founder review; not a saved Terraform plan and not authorization to deploy.** Scope is capture-only MD-a/MD-b plus approved follow-up fixes. No clinical flags, real patient data, production environment or model activation.

## Known baseline and evidence needed

[Environments](../../ops/environments.md) records the last read-only AWS observation on 2026-10-31: synthetic staging, database through migration 0065, an older API/worker image and older frontend. This session has not checked the live account, credentials, current task revisions, pending Terraform, DNS, database or release claim. Treat all those live facts as unverified until an authorized release session reads them.

Use the existing [staging release procedure](../../ops/staging-release.md), [readiness decisions](../../ops/foundations-readiness.md), [rehearsal](../../ops/staging-rehearsal.md) and [frontend publisher](../../ops/frontend-publish.md). Their current guards and saved-plan approval rules apply. Do not invent a release script, reuse an old approved plan/hash, or edit the shape checks to accommodate unrelated merged infrastructure.

## Review packet before live work

- Pin one reviewed merged commit for API, worker, verifier/migrator and frontend. Record its green required CI run, signed image digest and verified release records; a local branch or a passing unit test is not a released image.
- Record the source-list content version and source releases from that exact commit. Browser and API list versions must agree. Confirm FDA-only rights scope and visible NLM attribution/currency information.
- List pending infrastructure and migration changes from the authorized live status inspection. Any unrelated Terraform goes through its own INFRA plan/review. Migration 0066 is labelled **breaking**, not an online expand migration.
- Read migration 0066 up/down and the new ledger event/projection/verifier contract. Confirm the backup/restore evidence and choose the maintenance window, write fence, rollback decision point and forward-repair owner.
- Founder reads this plan, the concrete live plan text and target identity/account/region; authorizes that release and any required live preparatory reads/writes. This draft does not supply those approvals.

## Cutover sequence for that later authorized session

1. Confirm synthetic-only target, authorized identity, current state and exclusive release claim. Establish a tested restorable snapshot/backup and record the last verified ledger checkpoint without copying patient data into public evidence.
2. Fence medication/patient-affecting writes and drain the affected services for the breaking migration. API, worker and verifier versions must not straddle new medication ledger events. The separate [medication-write fence](../../ops/medication-write-fence.md) defaults closed and can refuse medication POSTs, but it is a per-process startup setting: it does not fence all patient writes or prove old requests/tasks drained. Its live configuration transition is not supported by the current fixed-shape release scripts. The approver must still select and rehearse the broader operational fence and a reviewed flag-transition path before proceeding; keep writes closed until all compatible services and the verifier are confirmed. No untested zero-downtime claim.
3. Prepare and review the current release's MIGRATE plan/artifacts, then apply only the approved saved plan and run migration/provisioning checks through the existing procedure. Confirm 0066 applied, no unexpected pending migrations and correct non-superuser grants/RLS.
4. Prepare/review the IMAGE plan and update API and worker to the same signed commit before reopening writes. Confirm every serving task and the verifier understand medication events, old tasks drained, readiness/privilege checks pass and the ledger verifies. Preserve the current synthetic clinical holds and production gate refusals.
5. Build the normal production frontend from that same reviewed commit with the approved staging OIDC/API settings. Use the existing publisher's dry-run/review procedure; no local-storage flags, fake IdP, test keys, source maps or development routes in publication. Publish assets before index and perform the defined invalidation only after API readiness and list-version alignment.
6. Smoke-test with authorized synthetic staging personas: clinician add/correct/stop; same-tenant clinical-reader current/earlier reads; administrator/no-role and second-tenant refusal; stale correction and request replay; ledger across all versions; attribution; compact 20-entry/mobile behavior. Confirm the list produces no drug–gene output and no drug value enters logs/security events. Preserve only synthetic/aggregate evidence.
7. If all acceptance gates pass, reopen writes using the reviewed operational procedure, monitor errors and verification, release the claim, and update environments.md and staging-expected.json together with exact observed versions and evidence. Do not update these authoritative applied-state records before an actual release.

## Stop and rollback

Before any medication event is written, reverting application artifacts is considered only against the actual migrated schema and verified compatibility. After medication rows/events exist, **do not run 0066 down or roll back to an old verifier blindly**: its down guard refuses populated medications and old event readers may not understand the ledger. Keep writes fenced and prefer a reviewed forward repair. A full restore requires explicit authorization, a known recovery point and an agreed treatment of every post-backup write; it is not an automatic "undo". Mismatched source lists, task versions, grants, tenant isolation, failed health or failed ledger verification stop the release.

Nothing was published, migrated or applied in AWS while preparing this document.
