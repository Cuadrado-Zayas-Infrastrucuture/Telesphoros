# Architecture

How the parts fit together today. Status and history: [STATUS.md](STATUS.md). Everything here runs on **synthetic data only**; nothing is
applied in AWS.

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
    └──► sidecars/report-reader (Python subprocess) ── the imported, test-only reader engine
```

The product [capability matrix](product-capabilities.md) distinguishes normal builds, local-storage opt-in, development routes and server pipeline gates. Main still declares PUT-only reports CORS; the GET-only download repair is local F07, so this architecture does not claim hosted browser downloads are accepted.

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

M2.3 is merged: the PostgreSQL queue, transactional outbox, stored-file verification, hourly upload sweep, scheduler and separate worker process exist. Worker Terraform, login provisioning, deployment contracts and alarms are written; they have not been accepted in a hosted environment. Scheduling code is not evidence that a worker is provisioned or that alarms are delivered. See [jobs](ops/jobs.md).

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

## Delivery
CI runs five required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`) plus an advisory lint; every GitHub
Action is pinned to a commit SHA ([ops/ci-cd.md](ops/ci-cd.md)). Infrastructure is Terraform that has **never been applied**
([ops/deployment.md](ops/deployment.md)).
