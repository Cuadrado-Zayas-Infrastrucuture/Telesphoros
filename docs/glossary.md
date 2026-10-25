# Telesphoros glossary

Product and engineering vocabulary for Telesphoros records and workflows. These definitions describe the software's concepts; clinical terms and guideline interpretation require separate pharmacist review.

Use the canonical terms in new product prose. Existing API and code names remain valid identifiers; the _Avoid_ lines flag ambiguous shorthand rather than require renaming them.

## Organizations and access

**Organization**:
The group within which memberships, patient records and reports share one access boundary. The code calls this boundary a tenant.
_Avoid_: account or workspace as a synonym for organization; tenant in product-facing prose.

**Membership**:
A person's recorded standing in one organization, including whether it is active or removed and which roles it grants.
_Avoid_: login or token as a synonym for membership.

**Role**:
A named set of permissions granted through a membership. Reader, clinician, admin and reviewer are distinct roles that may be combined.
_Avoid_: treating admin or clinician as another name for reviewer.

Usage: [identity and authority](auth.md#authority-and-revocation), [membership model](../apps/backend/src/membership/membership.ts).

## Patients, reports and files

**Patient**:
An organization's record representing the person to whom reports are attributed.
_Avoid_: member or user when referring to a patient record.

**Report**:
A registered source report associated with a patient, with declared file metadata and, once uploaded, an associated report file. Its declared format is VCF, structured JSON or lab PDF.
_Avoid_: PDF, upload or evaluation as a synonym for every report.

**Report file**:
The verified, version-specific file associated with a report, identified by its content and storage version.
_Avoid_: filename or latest object as a substitute for the report file's identity.

**Upload**:
The transfer of a declared report file through validation and commitment to its report.
_Avoid_: report creation or capture as a synonym for upload.

**Upload attempt**:
One declared attempt to supply a file for a report, bound to its caller and file declaration. An attempt may end without a committed report file.
_Avoid_: report or completed upload as a synonym for every attempt.

Usage: [report contract](../packages/shared-types/src/report.ts), [stored records](../apps/backend/src/storage/records.ts), [upload attempt](../apps/backend/src/storage/upload-attempt.ts), [validated intake](../apps/backend/src/reports/intake/intake.service.ts).

## Capture, review and evaluation

**Capture**:
A record of text obtained from one exact stored lab-PDF version, with the identities of its source file and captured text.
_Avoid_: report, evaluation or accepted capture when no acceptance decision is meant.

**Capture decision**:
A reviewer's recorded acceptance or rejection of a capture. An acceptance is made by someone who did not create the report, first request its upload, upload it or capture it.
_Avoid_: approval without naming what was accepted; acceptance as a synonym for both possible decisions.

**Patient-link decision**:
A recorded verification or rejection that a report's exact file version belongs to its assigned patient.
_Avoid_: capture acceptance or patient merge as a synonym for patient-link verification.

**Evaluation**:
A recorded processing outcome for an accepted capture using identified knowledge and engine versions, including either a hold or produced results.
_Avoid_: report, capture or recommendation as a synonym for the whole evaluation record.

**Active evaluation**:
An evaluation with no corrections, or whose latest correction is a reinstatement. Active describes its correction state, independently of whether it is current or its disposition is held.
_Avoid_: current or approved for clinical use as a synonym for active.

**Current evaluation**:
The newest evaluation of a report, provided it is active and the patient link for the report's current file has not been rejected. Otherwise the report has no current evaluation; an older active evaluation is never promoted automatically.
_Avoid_: newest active evaluation, latest successful result or clinically approved evaluation as a synonym for current.

Usage: [pipeline contracts](../packages/shared-types/src/lab-report.ts), [capture review](../apps/backend/src/lab-reports/captures.service.ts), [evaluation states](../apps/backend/src/lab-reports/lab-report.mapper.ts), [current-evaluation selection](../apps/backend/src/storage/postgres/ledger-records.repository.ts), [records and corrections](design/records-and-corrections.md).

## Corrections and history

**Correction**:
A new record that retracts, supersedes or reinstates an evaluation while preserving the original evaluation and its history.
_Avoid_: edit, overwrite or amendment as a synonym for an evaluation correction.

**Retraction**:
A correction withdrawing an active evaluation from reliance while retaining it in history.
_Avoid_: deletion or supersession as a synonym for retraction.

**Supersession**:
A correction replacing an active evaluation with a named, newer active evaluation of the same report. The superseded evaluation remains in history and takes no further corrections.
_Avoid_: overwrite, report replacement or reinstatement as a synonym for supersession.

**Reinstatement**:
A correction restoring a retracted evaluation to active state, made by someone other than the person who retracted it. It identifies the retraction being undone.
_Avoid_: new evaluation or undoing a supersession as a synonym for reinstatement.

**Audit ledger**:
An organization's ordered, tamper-evident chain of events binding recorded actions to their associated records.
_Avoid_: application log or report history as a synonym for the audit ledger.

Usage: [correction contract](../packages/shared-types/src/lab-report.ts), [correction rules](../apps/backend/src/lab-reports/corrections.service.ts), [correction scenarios](../apps/backend/test/lab-reports-corrections.e2e-spec.ts), [ledger design](design/records-and-corrections.md).
