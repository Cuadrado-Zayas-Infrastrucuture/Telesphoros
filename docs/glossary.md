# Telesphoros glossary

Product and engineering vocabulary for Telesphoros records and workflows. These definitions describe the software's concepts; clinical terms and guideline interpretation require separate pharmacist review.

Use the canonical terms in new product prose. Existing API and code names remain valid identifiers; the _Avoid_ lines flag ambiguous shorthand rather than require renaming them.

## Organizations and access

**Organization**:
The group whose members share access to patient records and reports. The code calls it a tenant.
_Avoid_: account or workspace as a synonym for organization; tenant in product-facing prose.

**Membership**:
A person's standing in an organization: active or removed, with assigned roles.
_Avoid_: login or token as a synonym for membership.

**Role**:
A set of permissions: reader, clinician, admin or reviewer. Roles can be combined; admin does not imply reviewer.
_Avoid_: treating admin or clinician as another name for reviewer.

Usage: [identity and authority](auth.md#authority-and-revocation), [membership model](../apps/backend/src/membership/membership.ts).

## Patients, reports and files

**Patient**:
An organization's record representing the person to whom reports belong.
_Avoid_: member or user when referring to a patient record.

**Report**:
A patient-associated record for an incoming laboratory document or data file. Registration can precede upload; accepted formats are structured JSON and lab PDF.
_Avoid_: PDF, upload or evaluation as a synonym for every report.

**Report file**:
The exact stored file version linked to a report.
_Avoid_: filename or latest object as a substitute for the report file's identity.

**Upload**:
Sending a report file to the system for validation and storage.
_Avoid_: report creation or capture as a synonym for upload.

**Upload attempt**:
One tracked attempt to upload a file; it may complete, fail or be cancelled.
_Avoid_: report or completed upload as a synonym for every attempt.

Usage: [report contract](../packages/shared-types/src/report.ts), [stored records](../apps/backend/src/storage/records.ts), [upload attempt](../apps/backend/src/storage/upload-attempt.ts), [validated intake](../apps/backend/src/reports/intake/intake.service.ts).

## Capture, review and evaluation

**Capture**:
Text obtained from a specific report-file version, recorded with its source.
_Avoid_: report, evaluation or accepted capture when no acceptance decision is meant.

**Capture decision**:
A reviewer's acceptance or rejection of a capture.
_Avoid_: approval without naming what was accepted; acceptance as a synonym for both possible decisions.

**Patient-link decision**:
Verification or rejection that a report's exact file version belongs to the assigned patient.
_Avoid_: capture acceptance or patient merge as a synonym for patient-link verification.

**Evaluation**:
The recorded outcome of processing an accepted capture or a reviewed structured revision: results or a hold.
_Avoid_: report, capture or recommendation as a synonym for the whole evaluation record.

**Active evaluation**:
An evaluation that has not been retracted or replaced, or has been restored.
_Avoid_: current, successful result or approved for clinical use as a synonym for active.

**Current evaluation**:
The report's newest evaluation, if active and the patient link for its current file has not been rejected. Otherwise none is current; an older evaluation is never promoted automatically.
_Avoid_: newest active evaluation, latest successful result or clinically approved evaluation as a synonym for current.

Usage: [pipeline contracts](../packages/shared-types/src/lab-report.ts), [capture review](../apps/backend/src/lab-reports/captures.service.ts), [evaluation states](../apps/backend/src/lab-reports/lab-report.mapper.ts), [current-evaluation selection](../apps/backend/src/storage/postgres/ledger-records.repository.ts), [records and corrections](design/records-and-corrections.md).

## Structured reports and the synthetic assessment

**Structured revision**:
A saved, append-only version of the findings read from a structured report.
_Avoid_: capture, which is text from a PDF.

**Finding review**:
A reviewer's decision on one saved finding, made by someone who did not upload or save that evidence.
_Avoid_: capture decision, which accepts or rejects a PDF capture.

**Synthetic assessment**:
An evaluation computed from a reviewed structured revision against synthetic knowledge, available only where the API runs with `SYNTHETIC_ASSESSMENT=enabled` (synthetic staging). Every result is labelled synthetic and not approved for clinical use.
_Avoid_: recommendation or clinical result as a synonym for a synthetic assessment.

**Synthetic knowledge**:
Invented phenotype and guideline content used only for tests and synthetic staging; never `knowledge/cpic`.
_Avoid_: guideline or CPIC content as a synonym for synthetic knowledge.

Usage: [structured preview and review](../apps/backend/src/patient-identity/structured-preview.service.ts), [assessment](../apps/backend/src/lab-reports/structured-assessment.ts), [synthetic structured knowledge](../data/fixtures/knowledge/synthetic-structured), [architecture](architecture.md#the-synthetic-assessment-synthetic-staging-only-spec-032-s3).

## Corrections and history

The code calls replacement `supersession` and restoration `reinstatement`.

**Correction**:
A new record changing an evaluation's standing while preserving its history.
_Avoid_: edit, overwrite or amendment as a synonym for an evaluation correction.

**Retraction**:
Withdrawing an evaluation from use.
_Avoid_: deletion or replacement as a synonym for retraction.

**Replacement**:
Replacing an evaluation with a newer active evaluation of the same report.
_Avoid_: overwrite, report-file replacement or restoration as a synonym for evaluation replacement.

**Restoration**:
Restoring a retracted evaluation to active status, approved by someone other than the person who retracted it.
_Avoid_: new evaluation or undoing a replacement as a synonym for restoration.

**Audit ledger**:
An organization's ordered, tamper-evident record of actions.
_Avoid_: application log or report history as a synonym for the audit ledger.

Usage: [correction contract](../packages/shared-types/src/lab-report.ts), [correction rules](../apps/backend/src/lab-reports/corrections.service.ts), [correction scenarios](../apps/backend/test/lab-reports-corrections.e2e-spec.ts), [ledger design](design/records-and-corrections.md).
