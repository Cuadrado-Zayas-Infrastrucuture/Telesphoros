# Status, history and working agreements

Read this first to pick the project up. Snapshot: **2026-10-11**. Update it in the same pull request as any change it describes.
Synthetic data only: the AWS BAA is not executed, nothing is applied in AWS, and nothing here is approved for clinical use.

## Synthetic correction history and stale views

The local SMART viewer now shows verified selected-evaluation correction metadata and withholds genomic/PDF content when existing evidence gates fail. It rechecks evidence every 15 seconds, clears it before revalidation, and enforces a 30-second freshness cap measured from server read start. Hidden/offline views, failed/expired checks and chart changes clear content and revoke PDF blob links; late responses cannot restore it. See [plan](design/plans/synthetic-correction-history.md), [runbook](ops/correction-history-preview.md) and [verification](verification/synthetic-correction-history.md). No backend writes, retention or clinical gate changes; no push/atomic-snapshot guarantee.

## Shared dependency build coordination

Workspace typecheck/test now finish one prerequisite-library build phase before running parallel consumers; recursive build uses pnpm’s topological graph without nested dependency rebuilds. Standalone backend/pilot commands retain their prerequisite builds. This fixes overlapping clean builds observed after #70 without serializing checks, disabling cleaning or changing clinical/retention settings. See [plan](design/plans/shared-build-race.md) and [verification](verification/shared-build-race.md).
## Authorized synthetic source PDF

The local SMART reader can opt into the existing authorized pinned-version download link, verify PDF bytes/version/size/digest against the accepted source, and embed them in the FHIR preview. The viewer offers a local synthetic PDF download. See [plan](design/plans/synthetic-source-pdf.md), [runbook](ops/source-pdf-preview.md) and [verification](verification/synthetic-source-pdf.md). No backend route, retention or clinical gate changes; no EHR writes or deployment.

## Stored synthetic PGx reads

The OpenEMR pilot can now opt into fresh, explicitly bound reads of stored synthetic evaluations through existing authorized API routes. It checks patient/tenant/principal identity, acceptance/correction/dispute state and source metadata, and never falls back to static fixtures on failure. The source is metadata-only unless the optional PDF retrieval above is configured. See [plan](design/plans/synthetic-stored-pgx.md), [runbook](ops/stored-pgx-preview.md) and [verification](verification/synthetic-stored-pgx.md). No production route, schema, retention or clinical-gate change; no real data or deployment.

## Synthetic versioned PGx FHIR preview

The isolated OpenEMR pilot now maps explicitly selected synthetic evaluation/source versions into a core FHIR R4 collection preview. It preserves source bytes and SHA-256, interpretation/knowledge/engine identities, and patient-bound references; stale, held, retracted, disputed or unconsented results are withheld without fallback. See [mapping contract](fhir-cds-hooks.md), [plan](design/plans/synthetic-pgx-fhir.md) and [verification](verification/synthetic-pgx-fhir.md). This is not a production FHIR/IG adapter or clinical interpretation. No EHR writes, retention changes or clinical gate changes.

## Restore-test scheduling

The [restore-test scheduling investigation](design/plans/restore-test-scheduling.md) addresses shared PostgreSQL contention in CI: service-backed Jest runs now use one worker, while unit-only runs keep the default parallelism. Test deadlines, assertions and concurrency exercised within each suite are unchanged. See [reproduction and verification](verification/restore-test-scheduling.md) for measured stress results and the limits of attributing the original runner timeout. Retention, clinical gates and production recovery behavior are untouched.

## Genomic storage documentation corrections

The [genomic storage guidance](genomic-storage.md) applies the [source evaluation](verification/genomic-storage-report-evaluation.md): separate legal retention requirements from product policy, preserve source reports alongside structured PGx results, and correct compression, licensing and HIPAA claims. This is documentation only; retention values, clinical gates, application behavior and infrastructure are unchanged. Unverified statistics and jurisdiction-specific requirements remain explicitly unresolved. The evaluation retains real workstation evidence links and adds repository-relative navigation for GitHub readers.

## Local synthetic OpenEMR SMART pilot

A separate development package, `@telesphoros/smart-pilot`, ports the synthetic read-only OpenEMR rehearsal from the deleted gateway repository onto this codebase. It validates chart launch, signed clinician identity and exact patient-bound FHIR reads; a standalone viewer displays synthetic fixtures and withholds genomic content without fixture consent. It does not call the clinical engine or mount routes in the production API. See [plan](design/plans/openemr-smart-pilot.md), [runbook](ops/openemr-smart-pilot.md) and [verification](verification/openemr-smart-pilot.md). No clinical approval, real data, AWS deployment or broader SMART integration is claimed.

## Current frontend foundation closure

Phase 0 skeleton accepted by founder on 2026-10-09. Phase 1 closure merged as PR #50, with all seven CI checks passing; the founder confirmed the merge. It adds local-screen field errors/focus, shared token controls, mobile/keyboard checks, separate form-component files and all-page chunk guards. That closure left standard product upload as a browser-only sample stub; its later transport slice is tracked below. Clinical logic and hosting were untouched. Evidence: [Phase 1 closure](verification/phase1-closure.md). No later phase is marked complete by this change.

## Current Phase 2 closure

The founder approved three separate slices: API privacy/input boundaries, bounded evaluation/dispute lists, then batched evaluation context reads. All three merged as PR #51, #52 and #53 with all seven checks passing. The final slice batches the selected page's acceptance/correction context; real PostgreSQL query count stays at 21 statements for pages of 1, 20 and 100 records. Internal complete dispute reads remain separate from public pages. See [pagination verification](verification/phase2-review-pagination.md), [batching plan](design/plans/phase2-evaluation-context.md) and [batching verification](verification/phase2-evaluation-context.md). Whole-Phase-2 founder acceptance remains open. Existing API/storage/auth code is not a claim that all later foundation phases are complete. No deployment, clinical approval or spending is authorized by these slices.

## Phase 3A database integrity

Founder approved the revised local/synthetic plan on 2026-10-10. PR #54 merged engine-enforced recommendation/report/patient agreement in separately committed NOT VALID/validation migrations, extended catalog acceptance and measured real repository query plans under the application role. Any historical mismatch stops validation without rewriting records; operational remediation needs a separately approved script. Its green database check masked two failed migration tests; merged #55 fixes pipeline exit propagation and isolates colliding fixture logins. Inspected #55 database logs have zero failures across all three tiers (1,511 / 1,692 / 1,693 passed); all seven checks passed. Its first image attempt failed during PostgreSQL setup; an image-only retry on the same head passed, without proving that initial setup cause resolved. See [plan](design/plans/phase3a-data-integrity.md) and [verification](verification/phase3a-data-integrity.md). Full Phase 3 acceptance remains open for product upload, report-file recovery and live provider/scheduler/drill evidence. Nothing is deployed or approved clinically.

## Phase 3B backup discovery

Founder authorized this continuation with “go” on 2026-10-10. Incomplete backup listings now throw `IncompleteBackupListingError`; latest recovery aborts before object reads, temporary files or restore execution instead of choosing from a truncated window. PR #56 merged after all seven CI jobs passed; inspected database tiers passed 1,531 / 1,712 / 1,713 with zero failures. Local boundary controls, emulator pagination and PostgreSQL/S3 regressions are recorded in [verification](verification/phase3b-backup-discovery.md); see the [scoped plan](design/plans/phase3b-backup-discovery.md). This does not accept all Phase 3.

## Phase 3C current-schema recovery rehearsal

PR #57 merged after all seven exact-head CI jobs passed. Inspected database tiers passed 1,537 / 1,718 / 1,719 with zero failures or actual missing-service notices. The built format 2 CLI restored a populated synthetic DB into a fresh PostgreSQL cluster, checked catalog/privileges/ledger and recorded exact dataset bytes with timings. See [plan](design/plans/phase3c-recovery-rehearsal.md) and [verification](verification/phase3c-recovery-rehearsal.md). Pinned PDFs and captured text were checked on primary storage; independent report copies and complete application recovery remain false. This is not production-scale RTO or live-provider/custody acceptance.

## Phase 3D1 report registration retries

Founder approved this prerequisite to standard product upload on 2026-10-10. Optional request keys make report metadata creation retryable per tenant and creator, with immutable original-input fingerprints, concurrent PostgreSQL uniqueness and soft-delete reservations. See [plan](design/plans/phase3d1-report-registration.md) and [verification](verification/phase3d1-report-registration.md). PR #58 merged after all seven exact-head CI jobs passed; inspected database tiers passed 1,558 / 1,739 / 1,740 with zero failures or missing-service notices. The product form transport is tracked separately below; authentication/hosting acceptance, report-file recovery and live provider/scheduler/custody remain separate gates. This does not accept all Phase 3 or authorize clinical use/deployment.

## Phase 3D2 standard synthetic upload

Founder approved the separate transport/UI plan with “go” on 2026-10-10 after PR #58. The standard VCF/JSON screen selects existing patients from bounded pages, registers with retry keys, transfers through an explicit storage-origin allowlist and shows success only after server verification. PR #59 merged at `e550100`; all seven exact-head CI jobs passed, with inspected database tiers 1,558 / 1,739 / 1,740, zero failures/missing-service notices and browser 54 + 18 passed. See [plan](design/plans/phase3d2-product-upload.md), [runbook](ops/report-upload.md), [verification](verification/phase3d2-product-upload.md) and [final delivery evidence](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/59). The committed slice documents retain their pre-CI snapshots; the published PR completes scoped verification. Retry state is limited to the mounted form; reload recovery, PDF/local experiment changes, independent report-file recovery, clinical processing and live deployment acceptance remain separate. Nothing is deployed or approved clinically.

## Independent report-file recovery planning

PRs #60/#61 merged the [reviewed design](design/plans/report-file-recovery.md) and readability polish. Founder then approved a separate local F1 implementation with “go”: a verified-restore-bound encrypted/authenticated catalogue, frozen source identities, exact translated copies/read-back, bounded discovery and completion-last protocol. See [F1 plan](design/plans/f1-evidence-catalogue.md), [library runbook](ops/evidence-catalogue.md) and [verification](verification/f1-evidence-catalogue.md). This slice has real PostgreSQL/Moto controls and aggregate JSON CI artifacts; PR #62 is merged, with all seven exact-head CI checks passed. F2 PR #63 is merged (`2a6022f`); all seven CI checks passed, including 1,794 PostgreSQL/S3 tests and validated artifacts for all three profiles. See the [F2 plan](design/plans/f2-independent-recovery.md), [runbook](ops/independent-recovery.md) and [verification](verification/f2-independent-recovery.md). F2 recovers all required bytes with primary denied and keeps application recovery false. Founder separately approved F3: its [plan](design/plans/f3-application-recovery.md), [runbook](ops/application-recovery.md) and [verification](verification/f3-application-recovery.md) cover an opt-in read-only resolver and actual synthetic application acceptance. F3 #64 is merged at `60a73aa`; all seven CI jobs passed, with inspected database tiers 1,630 / 1,811 / 1,812 passing tests and strict downloaded F2/F3 profile validation. The merged tree matches the reviewed/tested code; see [F3 final evidence](verification/f3-application-recovery.md#merged-delivery-evidence). Founder approved [F4 documentation-only preparation](design/plans/f4-provider-custody.md): provider/Region/custody/retention/budget decisions, operational producer/loader/startup and retained-destination configuration remain prerequisites. F4 live drill, scheduling and production infrastructure remain unimplemented. Moto metadata checks do not prove AWS Compliance/IAM enforcement. Whole Phase 3 and all founder deployment gates remain open.

## What exists on `main`

| Phase | What it added | Where to read more |
| --- | --- | --- |
| Scaffold, 1 | Monorepo layout; data and secret guards; frontend foundation (Vite, React, Tailwind) | [README](../README.md) |
| 2 | NestJS API foundation, shared contracts, auth guard layer | [auth.md](auth.md), `apps/backend/README.md` |
| 3 | PostgreSQL schema with row-level security, object-storage upload path (presigned PUT, server-verified), verified backup and restore | [database.md](database.md), [ops/backup-and-restore.md](ops/backup-and-restore.md) |
| 4 | Authentication with Amazon Cognito (verification, roles, `/me`, CORS, Terraform, UI) | [auth.md](auth.md) |
| 5A | CPIC knowledge schemas, signed-content loader, phenotype and recommendation engines | [cpic-integration.md](cpic-integration.md) |
| 5B-0 | Tenancy: records belong to an organization, not one user | [database.md](database.md) |
| 5B-1 | Multi-gene guideline tables, cell verification, five outcomes, frozen vocabulary | [design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md) |
| CI/CD | Real CI workflow, branch-protection ruleset (applied), Dependabot, CODEOWNERS, PR template; Node pinned to an exact release | [ops/ci-cd.md](ops/ci-cd.md) |
| 5B-2a | Lab-report reader sidecar with a byte-identical, **test-only** import of the hand-off engine; the report adapter | [lab-report-reader.md](lab-report-reader.md), [design/report-adapter-spec.md](design/report-adapter-spec.md) |
| BK-1, BK-2 | Authenticated encryption and signed manifest for backups; off-site copy to a second provider with a set-up self-test | [ops/offsite-backups.md](ops/offsite-backups.md) |
| 5B-3.0, 5B-3.1 | The specification, then the database layer: records, correction tables, the per-tenant hash-chained audit ledger, verifier, redaction, roles, backup and restore that preserve ownership and privileges | [design/records-and-corrections.md](design/records-and-corrections.md), [ops/ledger-roles.md](ops/ledger-roles.md) |
| 5B-3.2a (#20, #21) | Migration 0010 (the stored lab PDF is pinned to an object version and protected by the database), the `reviewer` role, `lab-pdf` type, version-aware object storage, the error contract, the `LAB_REPORT_PIPELINE` switch, six-year retention of overwritten report files in Terraform | [ops/report-evidence.md](ops/report-evidence.md), spec section 16 |
| 5B-3.2b-1 (#22, #24) | Capture, decision and file-link endpoints, the recorded-text runner, the checkpoint proving the pinned reader runs in CI | [lab-report-reader.md](lab-report-reader.md), spec section 17 |
| 5B-3.2b-2 (#29) | Evaluation endpoints (reader, adapter, engine, stored with the ledger), knowledge loading, the per-process reader limit, the dispute re-check after the ledger lock, D01 to D12 end to end against the hand-written expectations | [lab-report-reader.md](lab-report-reader.md), spec section 18 |
| 5B-3.3a | Corrections: retract, reinstate, supersede; correction history and derived state in every evaluation; `current` and `?current=true`; `GET /notes/:id` | [lab-report-reader.md](lab-report-reader.md), spec section 19 |
| 5B-3.3b | Disputes about guideline cells and the overlay that holds a disputed cell; the exact post-lock dispute re-check replaces the tenant-wide `dispute-active` refusal | [lab-report-reader.md](lab-report-reader.md), spec section 20 |
| 5B-3.3c | Ledger watch: the check at start (production refuses to start), the background and scheduled full walks, the `ledger-compromised` latch and the append gate, readiness `ledger`, `GET /ledger/verify`, and the restore-time `ledger chain` check | [ops/ledger-watch.md](ops/ledger-watch.md), spec section 21 |

## In progress and next

Slice 5B-3.2 (the pipeline endpoints) is complete. Slice 5B-3.3 (corrections, disputes, ledger watch) is complete; 3.3a, 3.3b and 3.3c are all merged. It was planned and approved ([design/plans/5b-3-3-corrections-disputes-ledger-watch.md](design/plans/5b-3-3-corrections-disputes-ledger-watch.md), decisions 24 to 30) and is built as three PRs:

- **5B-3.3a corrections, 3.3b disputes and the overlay, 3.3c ledger watch** (all built, above). The pipeline stays synthetic, off by default and refused in
  production. **No alarm exists in AWS for the `ledger-compromised` log line yet**: it is written as Terraform in F3b (below), never applied; see [ops/ledger-watch.md](ops/ledger-watch.md).
- **Disputed-cell evaluation listing**: implemented in this slice; exact file matches and historical candidates without provable file identity are shown separately. Read-only, paginated, and synthetic-only; see [verification and limits](clinical-validation/cell-usage-listing.md).
- **Hosting H1**: company site on Vercel, product on AWS, both domains in Jan's Cloudflare account. Optional private S3/CloudFront frontend configuration is written, disabled by default and never applied; see [hosting and DNS checklist](ops/domains-and-hosting.md). API host, WAF, deployment roles/state and live validation remain separate prerequisites (the CloudTrail audit trail is the next item).
- **Audit trail (F1)**: CloudTrail with S3 data events on the reports bucket, a locked log bucket with its own key, and six email alarms are written as Terraform and guard-tested, **never applied**; see [ops/audit-trail.md](ops/audit-trail.md). It satisfies the audit condition for the break-glass role once applied and tested; the role is still not created.
- **API rate limiting (F2)**: per-address (before sign-in) and per-person-by-route-class token buckets returning 429 `RATE_LIMITED`; per process; production requires `TRUST_PROXY_HOPS`; see [ops/rate-limiting.md](ops/rate-limiting.md). The frontend does not yet show a friendly 429 message.
- **API hosting, edge (F3a)**: ACM certificate, HTTPS-only load balancer, firewall and exact security groups for the API are written as Terraform and guard-tested, **off by default and never applied**; staging front end on Vercel, staging API on AWS in production mode. The compute (F3b) and the deployment pipeline (F4) are next; see [ops/api-hosting.md](ops/api-hosting.md) and [the plan](design/plans/f3-api-hosting.md).
- **API hosting, compute (F3b)**: ECS Fargate cluster and service, task and one-off migration task definitions, roles, secret containers (no values), a log group with its own key, and four alarms (including `ledger-compromised`) are written as Terraform and guard-tested, **off by default and never applied**; the task environment is checked against the application's own configuration loader. **Open before anything can run:** the image and pipeline (F4), the three database logins (no tool creates them yet), a VPC with a NAT route; see [ops/api-hosting.md](ops/api-hosting.md).
- **Shared ledger containment (FD-2, from the 2026-10-09 peer review)**: a walk that finds damage records an incident in the database (migration 0011); `ledger_append` refuses that tenant's writes in every task, other tenants carry on, `/ready` says `contained`, and only an operator can reopen it, after a full walk that began later has passed. A global hold stops everyone. Proved against real PostgreSQL (two sessions, a restart, a restore, the in-flight order) and by 20 injected defects; **not** proved in AWS. Two-person authorisation of a clearance waits for the second reviewer. See [ops/ledger-watch.md](ops/ledger-watch.md), [the plan](design/plans/fd2-ledger-containment.md), spec section 23. This also corrects the F3b wording that a damaged task "leaves rotation at once": the load balancer fails open, and the database is what contains the tenant.
- **Database logins command (FD-4a, from the 2026-10-09 peer review)**: `db provision-logins` (run as a one-off task) creates the application, ledger-verifier and migrator logins with generated passwords sent to the database only as SCRAM verifiers (the RDS parameter group logs DDL), writes the connection strings into the three Secrets Manager containers, is safe to run twice, `--rotate` replaces every password, and reads the result back from the catalog (each login a member of exactly its group; the verifier cannot append; the application cannot touch incidents; neither writes a ledger table). Terraform adds the task and two roles (the task role cannot read the administrator secret). Proved on PostgreSQL 16 by automated tests (and, once by hand, a non-superuser administrator on a pristine cluster, after which the migrator, which is not `CREATEROLE`, applied all 11 migrations; FD-4b automates that), the Secrets Manager calls on an emulator, and 24 injected defects; **not** proved on RDS, IAM, or Fargate (FD-7). The image and the CI rehearsal of the first deployment are FD-4b. See [api-hosting.md](ops/api-hosting.md#the-database-logins-db-provision-logins) and [the plan](design/plans/fd4-provisioning-image.md).
- **Synthetic Terraform profile (FD-3, from the 2026-10-09 peer review)**: `deployment_profile` (default `production`) lets the same root plan as a one-Region, small, destroyable rehearsal (`synthetic`: allowed only with `environment = "staging"`, creates its own VPC with public subnets and no NAT, refuses COMPLIANCE locks); production values are untouched and every relaxation is listed in one guard. CI now runs `terraform test` (an offline, mocked plan per profile, 13 runs including the refusals), which also found and fixed a latent bug: with the default variables the root could not be *planned* (two IAM policy documents indexed secrets that exist only with hosting on). Proved offline by `terraform test`, the text guards and injected defects; **not** proved in AWS (limits, the free plan, destroying locked buckets: the FD-7 rehearsal). See [the Terraform README](../infrastructure/terraform/README.md#deployment-profiles-fd-3) and [the plan](design/plans/fd3-synthetic-profile.md).
- **Database TLS contract (FD-1, from the 2026-10-09 peer review)**: connection URLs may not carry TLS parameters (refused at start-up and in the connection builder); `DATABASE_SSL` is the only TLS setting and `require` verifies certificate and host name at TLS 1.2+; the command-line tools use `verify-full`; the migration task now sets `DATABASE_SSL=require`; a static guard keeps every connection on the one builder. See [database.md](database.md#database-tls). The F3b wording that a damaged task "leaves rotation at once" is corrected by FD-2 (below).
- **API image and first-deployment rehearsal (FD-4b)**: a digest-pinned Node 22.22.0 image, owner-confirmed RDS trust bundle, compiled production dependencies with a frozen-resolution comparison, numeric non-root runtime, and a synthetic TLS PostgreSQL/Moto rehearsal. The new `image` CI check builds with retained OCI SBOM/provenance, blocks fixed HIGH/CRITICAL vulnerabilities, and exercises provisioning, pristine-startup refusal, migrations, health/readiness and cross-process tenant containment. Local verification and remaining limits are recorded in [the image runbook](../infrastructure/docker/README.md). This is configuration and local/CI evidence only: nothing applied, published, clinically released, or approved for production; the founder approved adding the live `image` merge gate on 2026-10-10, and effective main protection now requires it (other existing rules preserved; see [CI controls](ops/ci-cd.md)).
- **Adapter-side R05 offline prototype (#28)**: implemented and verified with synthetic development tests; see [offline verification](clinical-validation/report-lookup-offline-v1.md). Production record-store/API integration requires its own approved plan; the evaluation API still uses the existing report adapter. Real clinical content, independent validation and clinical/training release remain pending.
- **Local synthetic review workflow**: development-only upload, PDF comparison and operations pages with a portable launcher; see [runbook](../scripts/local-review/README.md) and [verification](verification/local-review.md). The optional pinned Poppler26.03.0 adapter accepts only D01; general production Poppler integration remains a separate slice.
- **Tableau (analytics)**: feasible as its own slice; synthetic data only until a BAA; a separate read-only role over de-identified aggregate
  views with small-cell suppression, ideally pointed at a restored copy. Not planned in detail.

## Waiting on a person (the founder)

BAA texts from the off-site backup provider candidates (Backblaze B2, Wasabi); two key custodians; provider choice; the first real off-site
restore drill; deployment approval and the company Vercel source/project; sertraline and CPIC clinical data and sign-off; the break-glass role that may delete object versions is **assigned to the founder** and described in
[ops/break-glass.md](ops/break-glass.md), but must **not be created** until the audit trail ([ops/audit-trail.md](ops/audit-trail.md)) has been applied and tested; applying the `reviewer` Cognito group (Terraform is
written, never applied).

## Decisions on record

The numbered decisions (1 to 16 in the 5B-3.2 plan, 17 to 23 in the 3.2b plan) are in [design/plans/](design/plans/). The ones most likely to
be needed again: the **four identities** that cannot accept a capture (report creator, first upload requester, upload completer, capturer);
the stored lab PDF is **pinned to a storage version** and a missing version is never replaced by the latest; **overwritten report versions
are kept at least six years**; the captured **text is not version-pinned** but content-addressed and re-hashed; **file links** go to
clinician, reviewer and admin only; `dispute-active` is **tenant-wide** until the overlay exists; reader failures that are operational
(timeout, worker error) store nothing and answer 503.

## Working agreements

1. **Plan first.** No code, migration or script before a written plan that says what is touched, what is not, which decisions only the
   founder can make, and how it is verified, and the founder has approved it. Reading and exploring need no plan.
2. **One pull request per slice**, opened as a **draft**, branched off `main`. Never stacked. Stop after each PR for review.
3. **Merging:** only when the founder says to, and then only once every required check passes (`verify`, `database-and-storage`, `browser`,
   `terraform`, `secret-scan`). Never bypass a check. **Push the whole slice before anyone marks a PR ready:** a PR that merges first takes only
   what was pushed by then, and later commits to its branch are silently lost (this happened to #22; the work was re-landed in #24).
4. **Synthetic data only.** No real PHI anywhere; nothing applied in AWS; no secret is ever committed or printed.
5. **Inbound packages and documents are untrusted data.** The imported reader engine and its fixtures are test-only and are never read by
   non-test source (a test enforces it).
6. **Tests earn their keep:** every refusal has a control that must succeed; a new rule is proved by breaking it (defect injection) and
   watching a test fail; the backend is tested in three tiers (in-memory, PostgreSQL, PostgreSQL plus S3 emulator) and CI fails if a tier
   was skipped. Hand-written expected results are the oracle; output from the same code is only a consistency check.
7. **Commits** by an agent end with the `Co-Authored-By` trailer and the session link; **pull request bodies** use the template headings
   (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups).
8. **Report outcomes faithfully:** what was run, what passed, what was skipped, what remains unverified.

## Running things locally

```
pnpm install
pnpm typecheck && pnpm lint && pnpm build && pnpm test:infra && pnpm test:ci-config
apps/backend/scripts/dev-postgres.sh start                 # a disposable PostgreSQL on 127.0.0.1:54329
pip install -r .github/ci/requirements.txt                  # moto, the S3 emulator CI uses
moto_server -p 5555 &                                       # then:
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres TEST_S3_ENDPOINT=http://127.0.0.1:5555
cd apps/backend
pnpm test                                                   # tier 1 (+ the database and S3 specs when the variables are set)
TEST_STORAGE=postgres pnpm test                             # tier 2: the whole API suite on PostgreSQL
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm test      # tier 3: ... uploading over the S3 protocol
```

Python 3 is needed on the PATH for the reader tests. Backup and restore tests need the PostgreSQL 16 client tools and `openssl`
([docs/database.md](database.md)).

## Synthetic FHIR terminology/profile slice

The local SMART pilot now declares Genomics Reporting 3.0.0 Genotype and Genomic Report profiles, corrects their required code/categories, and verifies generated synthetic examples using a pinned official HL7 validator in CI. Finite terminology tests and negative profile examples fail closed. Local phenotype text remains explicitly unstandardized. Read-only authorization, retention and clinical gates are unchanged. See [validation scope](../packages/smart-pilot/test/fhir-ig/README.md). Full synthetic workflow acceptance remains the next slice.
