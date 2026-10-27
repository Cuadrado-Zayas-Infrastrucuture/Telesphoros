# Data model: clinician result decisions (D01a, D01b), and the extension points after them

## 1. What is reused unchanged

| Entity | Table | Grain | Role here |
| --- | --- | --- | --- |
| Evaluation | `evaluations` | One engine run over one accepted capture | Source evidence; supplies `patient_id`, `created_at`, state via corrections |
| Result | `evaluation_results` | One drug row of one evaluation (`ordinal` from 0) | The thing decided about; `id` is the stable reference |
| Correction | `corrections` | One retract/supersede/reinstate of an evaluation | Drives basis status; never written by this feature |
| Dispute | `cell_disputes` + `cell_dispute_decisions` | One guideline cell (`guideline_id`, `guideline_version`, `guideline_content_sha256`, locator) | A dispute in force on the result's cited cell blocks a new decision |
| Note | `event_notes` | One free-text body (1 to 1000 chars), redactable | Optional narrative; only `{id, bodySha256}` reaches the ledger |
| Ledger | `ledger_events`, `ledger_heads` | One event per record row, hash-chained per tenant | New event type `clinician-result-decision` |

## 2. New table `clinician_result_decisions` (migration 0052)

One row = one clinician's recorded response to one result at one time. Append-only (the `refuse_mutation` and no-truncate triggers), FORCE row-level security, ledgered.

| Column | Type | Rule |
| --- | --- | --- |
| `seq` | bigint identity | Ordering within the tenant |
| `id` | uuid PK | App-generated (`newId()`), as evaluations do |
| `tenant_id` | text | `= app_tenant()` (BEFORE INSERT check) |
| `created_by` | text | `= app_actor()`; human only (`created_by_human` CHECK, as in 0023) |
| `created_at` | timestamptz | `now()`: recorded time |
| `ledger_event_id` | uuid | Deferred FK to `ledger_events`; `_has_event` constraint trigger |
| `result_id` | uuid | FK `(result_id, evaluation_id, tenant_id)` → `evaluation_results (id, evaluation_id, tenant_id)` |
| `evaluation_id` | uuid | FK `(evaluation_id, tenant_id, patient_id)` → `evaluations (id, tenant_id, patient_id)` |
| `patient_id` | uuid | Copied from the evaluation by the server; the FK makes a wrong-chart row impossible |
| `response` | text | CHECK in `accepted`, `modified`, `rejected`, `deferred`, `clarification-requested` |
| `reason_codes` | text[] | Each in the fixed list; empty only when `response = 'accepted'`; no duplicates; at most 8 |
| `note_id` | uuid null | FK `(note_id, tenant_id)` → `event_notes`; required when `reason_codes` contains `other-documented` |
| `occurred_at` | timestamptz | `<= created_at` (CHECK) and `>= evaluations.created_at` (BEFORE INSERT check) |
| `previous_decision_id` | uuid null | FK `(previous_decision_id, result_id, tenant_id)` → this table: a revision stays on the same result |
| `creation_request_id`, `creation_request_hash` | uuid, text | Pair CHECK; `UNIQUE (tenant_id, created_by, creation_request_id)` |

**Chain keys.** A partial unique index allows one first decision per result (`UNIQUE (tenant_id, result_id) WHERE previous_decision_id IS NULL`), and `UNIQUE (previous_decision_id)` allows one successor per decision. Together they make each result's history a single line, so two concurrent revisions of the same head cannot both commit (one gets `decision-stale`). This copies `corrections` (`0009:45-46`). Founder decision D4.

**Keys added to existing tables** (each makes 0052 `breaking` under the lint, which every migration since 0040 already is): `evaluation_results UNIQUE (id, evaluation_id, tenant_id)` and `evaluations UNIQUE (id, tenant_id, patient_id)`. Both are supersets of the primary key, so no existing row can violate them; each builds an index under `lock_timeout = '2s'`.

**Reason codes** (proposed; the clinical owner validates, D6): `contraindication`, `competing-clinical-context`, `prior-treatment-failure`, `patient-preference`, `access-or-cost-barrier`, `missing-information`, `suspected-source-problem`, `other-documented`.

**Ledger projection** (`projections.ts`): every column as stored, in the existing fixed encoding, with the note replaced by `{id, bodySha256}`, plus `kind: 'clinician-result-decision'`. `creation_request_*` are excluded, as for capture decisions (0044).

**Grants and policies**: as `0021:196-210` (app SELECT, INSERT; ledger SELECT; verifier SELECT). No UPDATE or DELETE for any role.

## 3. Temporal semantics

`occurred_at` is clinical time; `created_at` is arrival. They are equal unless the clinician says otherwise. Only full timestamps are accepted in this slice (no date-only precision). A late-recorded decision therefore keeps both times. `basis` in a read is computed at read time and is never stored, because it changes when the evaluation is corrected later and the row must not.

## 4. Derived views (read time, not stored)

- **Current decision of a result**: the chain head (the row with no successor).
- **Basis status now**: `retracted` or `superseded` (last correction); `quarantined` (patient link rejected for the report's current file); `disputed` (a dispute in force on the cited cell); `not-current` (a newer evaluation of the report exists); otherwise `active`. More than one can hold, so the read returns a list.

## 5. Retention

Kept as long as the evaluation records they point at (no deletion path exists for any ledgered record). No new retention period is introduced; the six-year report-file setting is not copied here.

## 6. Extension points (named, not built)

| Later slice | Attaches to | Note |
| --- | --- | --- |
| D02 presentation | `evaluation_results.id` | Delivery, render, open and acknowledge are separate event kinds; engine `shown` never implies one |
| D03 medication events, episodes | `patients` + optional `clinician_result_decisions.id` | A decision never implies an order or dispensing |
| D04 endpoints | episodes | Observed values before derived labels; explicit `not-assessed` |
| D05 eligibility | every patient-linked fact | Purpose, grant, interval, restriction; fails closed |
| D07 analysis/release | read-only projections | Counts by `response` per result are the first synthetic benchmark, labelled synthetic |
