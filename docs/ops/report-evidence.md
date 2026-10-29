# Report files as evidence

A lab PDF that has been captured, reviewed and evaluated is evidence: the records cite its exact bytes. This page says what protects those
bytes and what an operator must and must not do. (Slice 5B-3.2a. Nothing here is applied in AWS yet.)

## What pins a file

- The reports bucket **keeps object versions** (Terraform enables it; the application refuses to start with the pipeline on if the bucket
  does not).
- On `complete`, the server streams the stored object once and records, from that one response, its SHA-256 **and its storage version**
  (`reports.object_version`), plus who asked for the first upload link and who completed the upload.
- The database then refuses any change to that file's identity. Once a capture exists it also refuses to change the report's type, name,
  patient or deletion mark.
- Every read and every download link for a captured file names the version. If that version is gone, the read fails; it never serves the
  latest object instead.

## What an overwrite does

An upload link stays valid for up to its lifetime (5 minutes by default) and can be used more than once. Someone holding it can write a
new object to the same key after the upload was verified. That creates a **new version**: the report stays pinned to the verified one, and
nothing the records cite changes. The new version is simply never used.

## Retention and deletion

The configured period below is an existing product policy, not a claim that HIPAA sets a universal clinical-record retention period.
Applicable record-category requirements and legal holds still need confirmation; see [retention authorities and policy](../genomic-storage.md#retention-authorities-and-existing-policy). This clarification does not authorize a reduction or deletion.

- Overwritten (noncurrent) versions are kept at least **six years** (`reports_noncurrent_retention_days`, default 2190, enforced by a
  variable validation and an infrastructure test). Do not lower it: the pinned version of an overwritten file is noncurrent.
- **No principal in this Terraform module may delete object versions** (`s3:DeleteObjectVersion`). A documented break-glass role outside
  it may ([break-glass.md](break-glass.md): who holds it, how it is used, and why it must not be created until an audit trail exists), and using it must be
  recorded as an audit event with a reason. Versioning does not stop someone with that permission.

## Independent recovery

The [local F1 catalogue library](evidence-catalogue.md) binds verified DB membership to exact translated copies and observes destination policy metadata on Moto. Independent primary-denied recovery and application recovery remain unimplemented. Database restoration alone cannot recover a missing pinned PDF or captured text. The [report-file recovery design](../design/plans/report-file-recovery.md) defines exact-version/copy-mapping acceptance, Compliance Object Lock and conditional CRR evaluation. It also covers completed JSON and hash-bound text; text's VersionId is not persisted in the current schema. The design is reviewed; F1 is a local library. Neither is an applied production retention or recovery control.

## Download links

A link is a bearer credential: whoever holds it can download that version until it expires (default 120 seconds, 60 to 600). Links are
issued only after the tenant-scoped lookup, are never logged, and **turning the pipeline off does not revoke a link already issued**; the
lifetime is the bound.

## Switching the pipeline

`LAB_REPORT_PIPELINE=enabled` is for synthetic, non-production use and is refused in production. Disabling it stops new uploads and
completions of lab PDFs immediately; links already issued keep working until they expire.
