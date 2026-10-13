# M2.1c: wrong-chart quarantine, duplicate review and merge (plan)

Status: **plan only, awaiting founder approval.** No code, migration or script has been written. It completes slice M2.1 of the [repo audit and build plan](repo-audit-and-build-plan.md) (research task **T06**, audit findings **A04**, **A06**) after [M2.1a](m2-1-onboarding-patient-identity.md) (tenant registry, member administration) and [M2.1b](m2-1b-identifiers-and-patient-link.md) (identifiers, the verified report link and its evaluation gate), both built on local branches and not merged. Working agreement 1 requires the founder to approve this plan first. Kept as a local branch at the founder's request (no push, so no CI spend). Everything stays **synthetic**: the AWS BAA is not executed and nothing here lifts that.

The M2.1 plan left this slice as an outline: *"Wrong chart: rejecting a verified link quarantines the report and requires reviewer action on every current evaluation. Duplicates: an ambiguous second registration of the same identifier goes to a review list instead of creating a patient; merge and unmerge are alias records resolved at read time, never a rewrite of `tenant_id` or `patient_id` on existing rows, each needing a second person."* This plan makes that concrete and proposes **two pull requests**, because the two halves share no tables and differ a lot in size and risk.

| Slice | Content | Size |
| --- | --- | --- |
| **M2.1c-1** | Wrong-chart quarantine: what a *rejected* link means for evaluations that already exist, a reviewer work list, and the same honest label on evaluations whose report was never verified | small: no new table; changes how existing records are read and listed |
| **M2.1c-2** | Duplicate review and merge: a possible-duplicate list fed by identifier collisions, two-person merge and unmerge as alias records, and how every read resolves them | large: two new ledger record tables, one flag table, changes to several read paths |

## Problem, as the repository stands after M2.1b

1. **A rejected link blocks new evaluations and nothing else.** An evaluation made while the link was verified (or before M2.1b existed, when no link was ever recorded) stays `active`, stays `current`, and is shown exactly as before. Someone who rejects a link has said "this report is not this patient's", yet the result keeps appearing under that patient. The only existing remedy is a `retraction` with reason `wrong-patient` ([spec 4.2](../records-and-corrections.md)); nothing tells a reviewer which evaluations need it.
2. **A report's patient cannot be changed**, by design: `reports.patient_id` is referenced by composite foreign keys from captures, evaluations, corrections, link decisions and recommendations, all append-only. So after a rejection the report can never be "re-pointed".
3. **A second patient entered for the same person** is only refused when it collides on an identifier (`409 identifier-in-use`, M2.1b), and the collision is not recorded anywhere: the duplicate is invisible to everyone but the clinician who hit it. If two patient records for one person do exist, records are split across them and there is no way to say they are one person.
4. **Evaluations made before the link existed** carry no decision at all; nothing says so when they are read.

## M2.1c-1: quarantine

**Definition (derived, nothing stored).** A report is **quarantined** when the newest link decision about it names its *current* file and patient and says `rejected`. It stops being quarantined when a later `verified` decision for that file exists (a second look). A rejection is about the file it names: if the file is replaced, the report is simply unverified again, not quarantined.

**What it changes.**

- **Every evaluation read carries the link state.** `advisory` gains `patientLink`: `verified`, `unverified` (no decision for the current file, which includes every evaluation made before M2.1b) or `rejected`. `actionable` stays false; the existing strict DTO changes in one place and the frontend/contract tests with it. The mapper stays an allow-list.
- **A quarantined report's evaluations are not "current".** The current-evaluation rule ([spec 4.5](../records-and-corrections.md)) gains one more way to be "none": the report is quarantined. `GET /evaluations?current=true` no longer lists them. History is untouched and still readable.
- **A work list for reviewers.** `GET /patient-link/quarantine` (role `reviewer`; `clinician` read-only is a decision below) lists quarantined reports with the evaluations on them that are still `active`, so each can be retracted with the existing `wrong-patient` correction by a reviewer. A report drops off the list when none of its evaluations is `active` (all retracted or superseded) or the link is verified again.
- **No automatic correction.** A retraction is a person's act with a named author (and a reinstatement needs a different person); the system does not write one. Quarantine makes the need visible; it does not decide.
- **No re-pointing.** The remedy for a report on the wrong patient is to upload it again under the right patient. The wrong-chart report stays as history. (Alternative below.)

**What it does not change:** captures, acceptances, file links and downloads on a quarantined report (reviewers must be able to look), the gate on new evaluations (already refused), the ledger and its records, migrations (no new table; one read-path SQL change and, if a query plan needs it, an index).

**Verification (M2.1c-1).** Hand-written expectations for each state of the link × each state of the evaluation; a rejected link removes the report's evaluations from `current=true` and a later verified decision restores them; the work list lists exactly the active evaluations of quarantined reports, drops a report once all are retracted, is tenant-scoped, and is refused to a reader and to an administrator alone; legacy evaluations (no decision) read as `unverified`; a replaced file reads as unverified, not quarantined; query-plan test for the new current-evaluation clause; defect injection (ignore the rejection; ignore the file version; list another tenant's report; show a retracted evaluation); the existing evaluation, correction and dispute suites updated by hand for the new `advisory` field; docs.

## M2.1c-2: duplicate review and merge

**Records (all append-only; tenants isolated by row-level security).**

- `patient_duplicate_flags` (not a ledger record): `patient_id`, `other_patient_id`, `system` (the assigning authority whose number collided), `flagged_by`, `flagged_at`; one row per unordered pair. Written when `POST /patients/:id/identifiers` collides with an active identifier of another patient: the call still answers `409 identifier-in-use` and stores no identifier, and now also leaves a flag. The flag stores no number and no digest.
- `patient_merge_proposals` (ledger record, event type `patient-merge-proposal`): `kind` (`merge` or `unmerge`), `source_patient_id`, `target_patient_id`, `reason_code` from a frozen list (`shared-identifier`, `entered-twice`, `merged-by-mistake`), `created_by`.
- `patient_merge_decisions` (ledger record, event type `patient-merge-decision`): `proposal_id` (unique: one decision per proposal), `decision` (`approved`, `declined`), `created_by`, who **must differ from the proposer** (trigger, the same separation rule as disputes).

**Effect of a merge (derived, never a rewrite).** An approved `merge` makes `source` an **alias** of `target`; an approved `unmerge` of that pair ends it. `reports`, `evaluations`, `patients` and every other row keep their stored `tenant_id` and `patient_id`, which are immutable and referenced by append-only records. A patient's *group* is the set of patients that resolve to the same root, found with a recursive query bounded in depth. The database refuses (under the ledger lock, so two decisions cannot race): a merge whose source or target is not a root, a merge of a patient into itself or into one of its own aliases (a cycle), a patient in another organization, and an `unmerge` that names no merge in force. A **declined** proposal dismisses the pair: it leaves the review list and a later collision does not reopen it.

**What reads do.**

| Read or write | Behavior |
| --- | --- |
| `GET /patients` | Merged-away patients are left out by default (`?includeMerged=true` shows them); `PatientDto` gains `mergedInto` (the target's id or null) |
| `GET /reports`, `/evaluations`, `/recommendations` with `patientId` | The filter means the patient's whole group, so a bookmark to either patient finds everything |
| `POST /reports`, `POST /patients/:id/identifiers` onto a merged-away patient | `409 patient-merged`, naming the target |
| Link verification by identifier | A number registered on **any patient in the report's patient's group** matches; identifiers are never copied or moved |
| Existing link decisions, evaluations, corrections | Untouched: they name the patient as stored, and stay valid |

**Routes.** `GET /patient-duplicates` (clinical read): the review list, newest first, with each pair's labels and the system that collided. `POST /patient-merges` `{kind, sourcePatientId, targetPatientId, reasonCode}` (`clinician`, `reviewer`) proposes. `POST /patient-merges/:id/decision` `{decision}` (`clinician`, `reviewer`, not the proposer) decides. `GET /patient-merges` and `/:id` read the history. An administrator alone has none of these.

**Verification (M2.1c-2).** The collision leaves exactly one flag and no digest anywhere (privacy scan); a proposal needs a different person to decide, each of proposer, decider and administrator alone has a refusal test and a control; a merge changes what the filters, the list and the identifier match see, and an unmerge restores them exactly; cycles, double merges, cross-organization and non-root merges are refused at the database (checked with the owner connection) and under concurrency; no existing row of `patients`, `reports` or `evaluations` changes (a row-hash comparison before and after); the verifier, backup and restore cover both new ledger tables; query-plan tests for group resolution; migration, privilege and catalog tests; defect injection per rule; the existing suites updated by hand where a read now resolves groups; docs.

## Decisions for the founder

| # | Decision | Recommendation |
| --- | --- | --- |
| DQ-1 | Split M2.1c into M2.1c-1 (quarantine) and M2.1c-2 (duplicates and merge), each its own draft PR, c-1 first | Yes. Different size and risk, no shared tables |
| DQ-2 | Quarantine is derived from the newest link decision (no stored flag, no automatic correction); it lifts only by a later `verified` decision for the same file | Yes. A correction stays a named person's act |
| DQ-3 | A quarantined report's evaluations stop being `current`, every evaluation read shows `advisory.patientLink`, and legacy evaluations read as `unverified` | Yes. Changes the `advisory` contract and the current-evaluation SQL |
| DQ-4 | No re-pointing of a report to another patient; the remedy is to upload it again under the right patient | Yes. The report's patient is a database guarantee that every record is pinned to. Re-pointing would need its own record type and a plan |
| DQ-5 | An identifier collision leaves a possible-duplicate flag (still answers 409 and stores no number) | Yes. Otherwise duplicates are invisible |
| DQ-6 | Merge and unmerge are two-person ledger records (proposal, then a decision by someone else); who may propose and decide | Propose and decide: `clinician` or `reviewer`, decider is not the proposer, `admin` alone never. A stricter option is reviewer-only deciders |
| DQ-7 | Reads resolve groups as in the table above (merged-away patients hidden from the default list; filters mean the group; writes onto a merged-away patient refused) | Yes |
| DQ-8 | A declined proposal dismisses the pair permanently | Yes. Un-dismissing would be a new proposal |

M0 (T01: intended use, supported reports, regulatory assessment, retention classes) is still undecided. Nothing here handles real patient data. One T01 question touches this slice directly: whether a merged patient's records must stay individually retrievable under the retention rules. The alias design keeps every row and every identifier of both patients, so it is safe either way, but the answer may add a "show the pre-merge view" requirement later.

## What this does not touch

Real patient data and the BAA; Cognito and Terraform (no new secret, no new infrastructure); the worker and jobs (M2.3); extraction from report text (M3.1); screens (M3.2: both slices are API-only); the legacy `recommendations` table's contents; billing and entitlements. No change to the ledger's hash format or the projection of any existing record.

## Risks to watch

- **Contract change in c-1**: `advisory` is a strict DTO read by the frontend, the SMART connector and several suites; the change is one field but wide in tests.
- **Group resolution in c-2** touches several list queries. Each needs a query-plan check, and the recursion needs a depth bound and a proof that cycles cannot be written.
- **Ledger lock**: two more record types append under the tenant's head lock; a merge decision re-checks the graph after the lock, as the evaluation gate does.
- **M2.1b is not merged** (nor are M1.5 to M2.1a): both slices are stacked on local branches; push order is M1.5, M1.5b, M1.6, M2.1a, M2.1b, then these.

## What I need from the founder

Yes or change on DQ-1 to DQ-8. With the recommendations as written, implementation is M2.1c-1 as one PR, then M2.1c-2 as another, each starting from a short implementation note like the one M2.1b had.
