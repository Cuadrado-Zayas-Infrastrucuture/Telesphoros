# Architecture

How the parts fit together today. Status and history: [STATUS.md](STATUS.md). Everything here runs on **synthetic data only**; nothing is
applied in AWS.

## The shape

```
 browser (apps/frontend)
    │  HTTPS, bearer token (Amazon Cognito access token)
    ▼
 NestJS API (apps/backend), prefix /api/v1
    │  every request: authenticate → roles → (pipeline gate) → validate → work
    ├──► PostgreSQL 16 ── row-level security by tenant; append-only record tables; per-tenant hash-chained ledger
    ├──► S3 (versioned bucket) ── report files; presigned upload; version-pinned reads and links
    ├──► knowledge/ (signed content, loaded at start) ──► phenotype engine ──► recommendation engine
    └──► sidecars/report-reader (Python subprocess) ── the imported, test-only reader engine
```

## Identity, tenancy and roles
- **Authentication:** Cognito access tokens in production; an HMAC verifier for development and tests only (refused in production). The
  backend reads the whole set of groups a token carries: `reader`, `clinician`, `admin`, `reviewer`, plus exactly one `tenant:<id>` group.
  See [auth.md](auth.md).
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

1. **Upload** a `lab-pdf` report (presigned PUT); the server verifies size, type and SHA-256 and pins the object version.
2. **Capture** (`POST /reports/:id/capture`): fetch the pinned version, re-hash, extract text, store it, record a capture, all inside a
   protocol that refuses if the report changed in between. The text runner is currently a **recorded-text substitute** for twelve development PDFs.
3. **Decision** (`POST /captures/:id/decision`, reviewer): someone who did not create, upload or capture the report accepts or rejects.
4. **Evaluation** (`POST /reports/:id/evaluations`): refused unless the decision named is an acceptance and still the latest, the text is
   unchanged and no dispute is active; then the reader finds spans of text, the **adapter** turns them into engine input or holds the whole
   report ([design/report-adapter-spec.md](design/report-adapter-spec.md)), and the engine produces results stored with the ledger. The reader and
   engine run outside any transaction, at most a configured number at once per process; the dispute check repeats inside the storing transaction.
5. **Corrections and disputes** (5B-3.3, not built): retraction, supersession, disputed guideline cells and their overlay.

Details of the reader and adapter: [lab-report-reader.md](lab-report-reader.md).

## Delivery
CI runs five required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`) plus an advisory lint; every GitHub
Action is pinned to a commit SHA ([ops/ci-cd.md](ops/ci-cd.md)). Infrastructure is Terraform that has **never been applied**
([ops/deployment.md](ops/deployment.md)).
