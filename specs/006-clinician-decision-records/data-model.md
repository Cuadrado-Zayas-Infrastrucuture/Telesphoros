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

## 2. New table `clinician_result_decisions` (migration 0054 or later: 0052 and 0053 are taken on `main`; provisional until the branch is cut)

One row = one entry in a result's shared decision history: a clinician's decision, an amendment of how that decision was documented, or a withdrawal of an entry made in error. Append-only (the `refuse_mutation` and no-truncate triggers), FORCE row-level security, ledgered.

| Group | Column | Type | Rule |
| --- | --- | --- | --- |
| Identity | `seq` | bigint identity | Ordering within the tenant |
| | `id` | uuid PK | App-generated (`newId()`), as evaluations do |
| | `tenant_id` | text | `= app_tenant()` (BEFORE INSERT check) |
| | `result_id` | uuid | FK `(result_id, evaluation_id, tenant_id)` → `evaluation_results (id, evaluation_id, tenant_id)` |
| | `evaluation_id` | uuid | FK `(evaluation_id, tenant_id, patient_id)` → `evaluations (id, tenant_id, patient_id)` |
| | `patient_id` | uuid | Copied from the evaluation by the server; the FK makes a wrong-chart row impossible |
| Authorship | `created_by` | text | `= app_actor()`, human only (`created_by_human`, as in 0023). It names **both the decision-maker and the person who entered it**: entry on someone else's behalf is not supported in this slice (D2). |
| | `author_roles`, `membership_version` | text[], bigint | Copied by the BEFORE INSERT trigger from the author's live `tenant_memberships` row (`0017`), never from the request. The row must be active and its roles must contain `clinician`, so the role rule (D2) is enforced in the database as well as by `@Roles`. |
| History | `entry_kind` | text | `decision` (a clinical decision; a later one means the plan changed) · `amendment` (corrects how the previous entry was documented, same author, same clinical decision) · `entered-in-error` (withdraws the previous entry, same author, no clinical content) |
| | `previous_entry_id` | uuid null | FK `(previous_entry_id, result_id, tenant_id)` → this table. Null only for the first entry. Must be the current head. |
| Meaning | `response` | text null | `accepted`, `modified`, `rejected`, `deferred`, `clarification-requested`. Required for `decision` and `amendment`; null for `entered-in-error` |
| | `detail_codes` | text[] | Codes from vocabulary `cdr-v1` (section 2.1). The response decides which lists are allowed and required. No duplicates; at most 8. |
| | `review_by` | date null | `deferred` only, optional: when the clinician intends to reassess |
| | `note_id` | uuid null | FK `(note_id, tenant_id)` → `event_notes`; required when `change-other` or `other` is present |
| | `vocabulary_version` | text | `cdr-v1` (CHECK) |
| Time | `occurred_at` | timestamptz | When the clinician says the decision was made. `>= evaluations.created_at` and `<= created_at` |
| | `occurred_at_source` | text | `recorded` (not given: equal to `created_at`) or `reported` (given by the clinician) |
| | `created_at` | timestamptz | `now()`, the database clock (transaction time): **the recorded time**, used for every timeliness measure |
| Evidence | `eligibility_policy` | text | `cdr-eligibility-v1` (CHECK): the basis rule the write was checked against at commit (D3) |
| | `ledger_event_id` | uuid | Deferred FK to `ledger_events`; `_has_event` constraint trigger |
| Reliability | `creation_request_id` | uuid | **Required** (D7): `UNIQUE (tenant_id, created_by, creation_request_id)` |
| | `creation_request_hash` | text | SHA-256 of the canonical request fields only (result, evaluation, patient, kind, previous entry, response, codes, review date, note body, reported time); no server-set value enters it |

Shape rules (CHECK): `amendment` and `entered-in-error` need `previous_entry_id`. Their author must equal the previous entry's author (BEFORE INSERT check). `entered-in-error` cannot follow `entered-in-error`. `review_by` is only for `deferred`.

**Chain keys.** `UNIQUE (tenant_id, result_id) WHERE previous_entry_id IS NULL` and `UNIQUE (previous_entry_id)` make each result's history one line. Two concurrent writes on the same head cannot both commit; one gets `decision-stale`. This copies `corrections` (`0009:45-46`).

**Keys added to existing tables** (each makes 0052 `breaking`, as every migration since 0040 is): `evaluation_results UNIQUE (id, evaluation_id, tenant_id)`, `evaluations UNIQUE (id, tenant_id, patient_id)`. Both are supersets of the primary key, so no existing row can violate them.

**Ledger projection** (`projections.ts`): every column as stored, in the existing fixed encoding. The note is replaced by `{id, bodySha256}`. `creation_request_*` are excluded, as for capture decisions (0044).

**Grants and policies**: as `0021:196-210` (app SELECT, INSERT; ledger SELECT; verifier SELECT). No UPDATE or DELETE for any role.

### 2.1 Vocabulary `cdr-v1`: decided (D6, 2026-10-28)

The founder asked for a simpler vocabulary, and the first draft (24 codes in four response-specific lists) became an 11-code proposal. On 2026-10-28 the founder accepted the recommended change to it: `drug-interaction` is split out of `clinical-context`, and `report-doubt` is split out of `information-needed`. The result is **13 codes in two lists**. One reason list is shared by every response that departs from the recommendation. The display labels are `CDR_CODE_LABELS` in shared-types; changing a label is not a new version.

**What kind of change** (`modified` only; at least one):

| Code | Meaning |
| --- | --- |
| `change-drug` | A different drug than recommended |
| `change-dose` | A different dose, frequency or duration |
| `change-monitoring` | Added or changed monitoring (levels, labs, follow-up) |
| `change-other` | Anything else; note required |

**Why** (shared: at least one for `rejected`, `deferred` and `clarification-requested`; optional for `modified`; none for `accepted`):

| Code | Meaning |
| --- | --- |
| `not-applicable` | The result does not fit this patient's indication or situation |
| `drug-interaction` | A co-medication outweighs or changes the result (an interaction, or a phenotype changed by an inhibiting or inducing drug) |
| `clinical-context` | Another clinical reason: a contraindication, a comorbidity or a prior response |
| `disagree-with-guideline` | Clinical disagreement with the guideline recommendation itself |
| `patient-preference` | The patient declined after discussion |
| `access` | Cost, coverage or availability |
| `information-needed` | Something is needed first: another result or specialist input |
| `report-doubt` | Doubt about the source report itself (a quality signal about the lab or the capture, not about the patient) |
| `other` | Anything else; note required |

`deferred` keeps the optional `review_by` date. The response itself carries the rest of the meaning: `deferred` plus `information-needed` means waiting for something, and `clarification-requested` plus `information-needed` means the clinician asked a question.

**What the vocabulary still folds together**, accepted on purpose:
- A contraindication, a comorbidity and a prior response are all `clinical-context`.
- A schedule change is `change-dose`.
- Coverage and availability are both `access`.

Splitting a code later is a new vocabulary version (`cdr-v2`), and old rows keep `cdr-v1`. So starting coarse is reversible for new data, but not for data already collected.

A `modified` decision records the **intended** change only. It is never evidence that a drug was ordered, changed, dispensed or taken; that is D03.

## 3. Temporal semantics

`occurred_at` is clinical time as reported; `created_at` is the database's recorded time. Every timeliness measure uses `created_at`, so a backdated `occurred_at` can never make a late entry look timely. Neither clock affects eligibility, which is always checked at commit (D3). `occurred_at` may not be after `created_at`. A client that means "now" omits it, so client clock skew cannot cause a refusal. Only full timestamps are accepted (no date-only or approximate precision in this slice); approximate times are a documented capture limitation. `basis` is computed at read time and never stored.

## 4. Derived views (read time, not stored)

- **Head**: the entry with no successor.
- **Current decision of a result**: walk back from the head. An `entered-in-error` entry removes the entry it follows. The current decision is the newest remaining `decision` together with any `amendment` that follows it. If none remains, there is no current decision. Every entry stays in the history with its author.
- **Plan changes**: count `decision` entries only. Amendments and withdrawals are documentation events, not clinical changes.
- **Disagreement**: a `decision` by clinician B after clinician A's is a new team decision. Both are attributed and shown in order. B cannot amend or withdraw A's entry.
- **Basis status now**: any of `retracted`, `superseded` (last correction), `quarantined`, `disputed`, `not-current`; otherwise `active`.

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
