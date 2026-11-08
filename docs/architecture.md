# Architecture

How the parts fit together today. Status and history: [STATUS.md](STATUS.md). Everything here runs on **synthetic data only**. One
synthetic staging environment runs in AWS and there is no production; what is applied there is in [ops/environments.md](ops/environments.md).

## The shape

```
 browser (apps/frontend)
    │  HTTPS, bearer token (Amazon Cognito access token)
    ▼
 NestJS API (apps/backend), prefix /api/v1
    │  every request: authenticate → membership and roles (database) → (pipeline gate) → validate → work
    ├──► PostgreSQL 16 ── row-level security by tenant; append-only record tables; per-tenant hash-chained ledger
    ├──► S3 (versioned bucket) ── validated API intake; version-pinned reads and signed GET links
    ├──► knowledge/ (signed content, loaded at start) ──► phenotype engine ──► recommendation engine
    └──► sidecars/report-reader (Python subprocess) ── the imported, test-only reader engine (optional: not in the public repository)
```

A separate worker process (`apps/worker`, with the shared primitives in `packages/jobs`) runs the queued jobs against the same PostgreSQL; see "Jobs and operational acceptance" below.

The [current supported modes](product-capabilities.md#current-supported-modes-2026-11-07) distinguish normal builds, local-storage opt-in, development routes, synthetic staging and server pipeline gates. Main declares GET-only reports CORS (`infrastructure/terraform/reports-cors.json`). File download is offered only by the local-storage build, so the hosted staging build offers none and this architecture does not claim hosted browser downloads are accepted.

## Identity, tenancy and roles
- **Authentication:** Cognito access tokens in production; an HMAC verifier for development and tests only (refused in production). A
  verified token proves who the caller is and names exactly one `tenant:<id>` group.
- **Authority:** what the caller may do is read from the database on every request (`tenant_memberships`: active or removed, and the roles
  `reader`, `clinician`, `admin`, `reviewer`), so a removal or role change takes effect on the next request on every instance, and a lookup
  failure refuses the request. Request-driven writes re-check it at commit. See [auth.md](auth.md#authority-and-revocation).
- **Tenancy:** every record belongs to an organization (`tenant_id`) and records the individual who made it (`created_by`). The database
  enforces the tenant boundary with forced row-level security; the application role cannot bypass it. A foreign or unknown id is 404.
- **Roles are additive.** `reviewer` is never implied by another role; an `admin` alone cannot accept a lab-report capture.

## Data and the audit ledger
- **PostgreSQL** holds metadata and records, never file bytes. Migrations are numbered with a matching down file ([database.md](database.md)).
- **Append-only record tables** (captures, acceptances, evaluations, corrections, disputes) each have their own event in a **per-tenant
  hash chain** committed in the same transaction. The design is [design/records-and-corrections.md](design/records-and-corrections.md); the
  roles that own and verify it are in [ops/ledger-roles.md](ops/ledger-roles.md).
- **Backups** are encrypted (authenticated format), signed, restorable with ownership and privileges checked, and can be copied off-site to a
  second provider ([ops/backup-and-restore.md](ops/backup-and-restore.md), [ops/offsite-backups.md](ops/offsite-backups.md)).

## Files as evidence
Report files live in a **versioned** S3 bucket. On upload the server streams the object once and records its SHA-256 **and its storage
version**; the database then refuses any change to that file's identity, and later reads and links name the version. See
[ops/report-evidence.md](ops/report-evidence.md).

## Jobs and operational acceptance

M2.3 is merged: the PostgreSQL queue, transactional outbox, stored-file verification, hourly upload sweep, scheduler and separate worker process exist. The worker runs in synthetic staging (one task: the upload sweep, stored-file checks and expired-capability removal); the three capability-sweep alarms were each fired once on purpose, and no other worker alarm has been, so alarm delivery is only partly exercised. Nothing here runs in production, which does not exist. What runs, and what was read when: [environments.md](ops/environments.md). Scheduling code alone is not evidence that a worker is provisioned or that alarms are delivered. See [jobs](ops/jobs.md).

## Knowledge and engines
- `knowledge/cpic` is loaded at start under production rules (nothing synthetic or unreviewed). It is empty until clinical sign-off, so in
  production every drug reports "no matching guideline". Test-only knowledge for the pipeline lives in `data/fixtures/knowledge/test-only-reader`.
- The **phenotype engine** maps a diplotype to a phenotype; the **recommendation engine** is deterministic: wording, strength and version are
  copied from the guideline, a result is `shown` only when every gene resolved and the guideline has a verified cell for exactly that
  combination, and every other case is one of five outcomes with a reason code ([design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md),
  [cpic-integration.md](cpic-integration.md)).

## The lab-report pipeline (a synthetic, non-production integration)
Off by default (`LAB_REPORT_PIPELINE`); refused in production and with the in-memory store. A PDF goes through these steps, each by a
different person where the rules say so:

1. **Upload** a `lab-pdf` through an immutable attempt and raw-byte API intake; structural validation precedes any bucket write, and the committed file pins size, type, SHA-256 and storage version. The pipeline gate applies to declaration, transfer and resume.
2. **Capture** (`POST /reports/:id/capture`): fetch the pinned version, re-hash, extract text, store it, record a capture, all inside a
   protocol that refuses if the report changed in between. The text runner is currently a **recorded-text substitute** for twelve development PDFs.
3. **Decision** (`POST /captures/:id/decision`, reviewer): someone who did not create, upload or capture the report accepts or rejects.
4. **Evaluation** (`POST /reports/:id/evaluations`): refused unless the decision named is an acceptance and still the latest, the text is
   unchanged; then the reader finds spans of text, the **adapter** turns them into engine input or holds the whole
   report ([design/report-adapter-spec.md](design/report-adapter-spec.md)), and the engine produces results stored with the ledger. The reader and
   engine run outside any transaction, at most a configured number at once per process. Disputed guideline cells are held by an **overlay** (the engine already holds a disputed cell with no wording); the disputes it read are re-checked inside the storing transaction after the ledger lock.
5. **Corrections** (`POST /evaluations/:id/corrections`, reviewer): retraction, supersession and reinstatement, each a new ledgered record; the evaluation is never edited, its state is derived from its corrections, and `current` marks a report's newest evaluation if it is active (none if the newest is retracted). **Disputes** (`POST /cell-disputes`, reviewer): a disputed guideline cell is held by an overlay at the next evaluation. **The ledger watch** (5B-3.3c, [ops/ledger-watch.md](ops/ledger-watch.md)) verifies each tenant's chain at start (production refuses to start on a failure), walks it in full in the background and on a timer, shows the result in `/ready`, and on damage records an **incident in the database** (FD-2, migration 0011): `ledger_append` then refuses that tenant's writes in every task (503 `LEDGER_COMPROMISED`) while the other tenants carry on, until an operator clears it after a later full walk has passed. Restore re-walks every chain.

Details of the reader and adapter: [lab-report-reader.md](lab-report-reader.md).

## The synthetic assessment (synthetic staging only, spec 032 S3)
The path the MVP uses to show a stored result on staging. Staging runs with `NODE_ENV=production`, which refuses the lab-report pipeline, so
this is a separate switch, `SYNTHETIC_ASSESSMENT` (off by default), for **structured** reports (JSON), never PDFs:

1. **Upload** a structured report through the same validated intake.
2. **Review** (`/reports/:id/structured-preview`): a `reviewer` who did not upload or save the evidence verifies the patient link and decides
   each saved finding. The revisions and finding reviews are append-only and ledgered (migrations 0068 and 0069).
3. **Assess** (`POST /reports/:id/structured-assessment`, `clinician` or `reviewer`): once every finding has a decision, the existing engine
   evaluates the findings against its own synthetic knowledge, `data/fixtures/knowledge/synthetic-structured` (copied into the image as
   `/app/synthetic-knowledge`). The result is stored as an evaluation with a structured source (migration 0070) and the ledger. An incomplete,
   conflicting or unsupported finding holds; nothing is inferred.
4. **Read** (`GET /evaluations`, `GET /evaluations/:id`): the patient page shows the stored result (outcome, reason code, citation), labelled
   synthetic and not approved for clinical use. Clinician decisions, acknowledgements, corrections and disputes stay off (503).

Three switches must agree. The API refuses `SYNTHETIC_ASSESSMENT` beside the pipeline and in a disposable local run. Terraform sets it only through
`synthetic_assessment_enabled`, which the synthetic profile alone accepts. The frontend shows the UI only when built with `VITE_SYNTHETIC_ASSESSMENT=true`,
which the publish script sets only with `--with-synthetic-assessment`. Code: `apps/backend/src/lab-reports/structured-assessment*.ts`,
`apps/backend/src/patient-identity/structured-preview.*`, `apps/frontend/src/components/StructuredAssessment.tsx`. Decisions and slices:
[design/plans/pgx-synthetic-assessment.md](design/plans/pgx-synthetic-assessment.md). Turning it on and off:
[ops/synthetic-assessment-switch.md](ops/synthetic-assessment-switch.md). Whether staging runs it: [ops/environments.md](ops/environments.md).

## Delivery
CI runs six required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) plus an advisory lint; every GitHub
Action is pinned to a commit SHA ([ops/ci-cd.md](ops/ci-cd.md)). Infrastructure is Terraform, applied by hand to one synthetic
staging environment and nowhere else ([ops/environments.md](ops/environments.md), [ops/deployment.md](ops/deployment.md)).
