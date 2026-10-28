# Feature Specification: Clinician decisions on evaluation results, the first record of the decision-and-outcome data model (CDR)

**Feature Branch**: `docs/data-products-d00` (spec and plan only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-27

**Status**: [plan.md](plan.md) D1 to D5, D7 and D8 approved by the founder on 2026-10-27; D6 (vocabulary `cdr-v1`) held. Slice D01a (result reference) merged as PR #109 (2026-10-28). D01b (clinician result decisions) is not implemented.

**Input**: *Telesphoros data product architecture and Claude Code implementation report* (founder, 2026-10-27), read in full as requirements data. Mapping against `main` `704d5c4`: [research.md](research.md). Data model: [data-model.md](data-model.md). Contracts: [contracts/clinician-decisions.md](contracts/clinician-decisions.md).

## Product scope

The long-term direction is **one longitudinal evidence model with product-specific analytical views**, sold only as **aggregate analyses** of what the decision-and-outcome record shows. Its value rests on provenance, valid denominators, follow-up and reproducibility. The record must keep six facts apart: what was known at decision time; what the deterministic engine produced; what a clinician saw and decided; what treatment was ordered, dispensed, administered or taken; what was observed later, including missing follow-up; and which records may contribute to which analysis and release.

**This spec covers only the first link**: a stable reference to an existing engine result (D01a) and a synthetic clinician decision about that exact result, with its history (D01b). Every later slice in the report's roadmap (D02 to D11) needs its own plan. **Capture limitations accepted for this slice:** no proxy entry (the author is the decision-maker); no retrospective documentation once the basis is no longer eligible; full timestamps only; intended modifications are coded by kind, not by drug or dose value.

## User journeys (synthetic)

1. **A clinician records a response to a shown result.** They open an active, current evaluation, choose one result, and record `accepted`, `modified`, `rejected`, `deferred` or `clarification-requested`, with reason codes when it is not `accepted`, an optional note and the clinical time if it differs from now. A retry after a network failure returns the same record.
2. **The plan changes, or the record was wrong.** If new information changes the plan, a clinician records a new `decision`. If the entry was mis-documented, its author records an `amendment`. If it was made on the wrong result, its author records `entered-in-error`. Every entry stays in the history, attributed.
2a. **Two clinicians disagree.** A later `decision` by another clinician becomes the team's current decision; the earlier one stays, attributed to its author.
3. **Anyone with clinical read access reads the history** of a result: every decision oldest first, which one is current, and what the source evaluation's status is *now* (still active, retracted, superseded, disputed, or quarantined).
4. **A reviewer retracts the evaluation after a decision.** The decision remains a historical fact, and its history shows the basis is now retracted. A decision attempted after the retraction is refused.

## Semantic dictionary

| Term | Meaning here | Is not |
| --- | --- | --- |
| Engine outcome | `evaluation_results.outcome`: shown, held, abstained, no-published-recommendation, no-guideline | Proof a person saw it; a clinical outcome |
| Evaluation disposition | `evaluations.disposition`: held or evaluated (engine) | A clinician decision |
| Capture decision | A reviewer accepting or rejecting extracted text | Accepting a recommendation |
| **Clinician result decision** | A clinician's recorded response to one exact result | Treatment implementation; a presentation event; an endpoint |
| `occurredAt` | When the clinician says the decision was made | When it was stored (`createdAt`) |
| Basis status | The source evaluation's state when read | A property of the decision itself |
| Correction | Retract, supersede or reinstate an *evaluation* (reviewer) | A clinician disagreeing with a result |

## Requirements

- **FR-001** Each result in `GET /evaluations/:id` (the list returns summaries without results) carries its stored `id` (UUID) and `ordinal`. No stored hash, ledger event or projection changes.
- **FR-002** `POST /evaluation-results/:id/clinician-decisions` stores one decision about that exact result. Tenant, author and patient come from the server (the token and the result's own evaluation), never from the body.
- **FR-003** The body must also name the `evaluationId` and `patientId` the caller is looking at. A mismatch with the stored relationship is refused (409, nothing stored). Another tenant's result reads as 404.
- **FR-004** The database itself refuses a decision row whose result, evaluation, patient and tenant do not belong together (composite foreign keys), whatever the service does.
- **FR-005** Only a person whose **live membership** holds `clinician` may write. This is checked by the route and again by the database trigger, which copies the roles and membership version onto the row. `reader`, `reviewer` and `admin` without `clinician` are refused (403). The author is both decision-maker and recorder; proxy entry is not supported.
- **FR-006** At commit, under the tenant's ledger lock, the basis is re-checked: the evaluation is active and current, its report is not quarantined, the result's outcome is `shown`, and the result's cited cell has no open or upheld dispute. Otherwise 409 `decision-basis-unavailable`, nothing stored.
- **FR-007** Entries are append-only and ledgered in the same transaction as their row. Each names the result's current head (`previousEntryId`); a stale head is 409 `decision-stale`. `entryKind` is `decision`, `amendment` (same author, documentation fix) or `entered-in-error` (same author, withdrawal). Another clinician's entry can be followed only by a new `decision`.
- **FR-008** `requestId` (UUID) is **required**. A replay with the same canonical request returns the original (200) before any eligibility check. The same id with a different request is 409 `request-id-reused`. Concurrent identical requests store exactly one row. Server-set values never enter the fingerprint.
- **FR-009** Detail codes come from vocabulary `cdr-v1` (data-model 2.1; held for the founder's edits), stored with its version. `modified` needs at least one "what kind of change" code. `rejected`, `deferred` and `clarification-requested` need at least one shared "why" code. `accepted` takes none. `change-other` and `other` need a note. A note is an existing event note: only its id and hash reach the ledger, and it is read through `GET /notes/:id`.
- **FR-010** `createdAt` (database clock) is the recorded time and the only clock for timeliness. `occurredAt` is optional (omitted = `createdAt`, `occurredAtSource: recorded`) and must lie between the evaluation's `createdAt` and `createdAt`. Neither clock affects eligibility.
- **FR-011** `GET /evaluation-results/:id/clinician-decisions` returns the history oldest first, the current head, and the basis status now. A decision committed before a later retraction stays readable.
- **FR-012** Nothing in this feature changes a recommendation's wording, an engine outcome, a hold, a correction or a capture decision, and no decision ever changes `actionable` (still literally `false`).
- **FR-013** The routes are behind the existing lab-report pipeline switch: synthetic only, refused in production.

## Metric contract: result-level decision documentation within W days

A definition for D07 to implement. It is **not computed in this spec**, and the H1 40% outcome target is not transferred to it.

| Element | Definition |
| --- | --- |
| Name | Result-level decision documentation within W days (synthetic until real data is authorized) |
| Counting unit | Distinct `evaluation_results.id`. Several entries, revisions or retries on a result count once. |
| Start time | The result's evaluation `createdAt`: under `cdr-eligibility-v1` a `shown` result on an active, current, unquarantined evaluation is eligible from creation. A result that becomes eligible later, which is not possible under v1, would need a stored start time. |
| Eligible results | `shown`, eligible under the named policy version at start time |
| Numerator | Eligible results with at least one `decision` entry whose `createdAt` ≤ start + W and that was not withdrawn by `entered-in-error` before the cutoff T |
| Denominator | Eligible results with start + W ≤ T (mature window) |
| Reported alongside | Pending results (immature window); distinct results, patients and decision entries; response distribution; entries recorded after W; results whose source was later retracted, superseded or quarantined, reported separately and **kept** in the cohort |
| Missing | "No decision documented": never read as rejection, deferral, implementation or outcome |
| Re-evaluations | A new evaluation has new result ids, so the metric is result-level until opportunity grouping (D02) exists |
| Versioning | The metric definition, eligibility policy and vocabulary versions are all named in every output |

Engine `shown` is not evidence that anyone saw the result; this counts documentation, not review.

## Success criteria

- **SC-001** Every FR has a test on the PostgreSQL tier through the HTTP API or the stored rows, and every refusal has a control that succeeds.
- **SC-002** Removing each guard (role, composite FK, post-lock basis check, request hash compare, chain uniqueness, time window) makes a named test fail (mutation table in the verification record).
- **SC-003** The ledger verifies after the migration on a database populated before it (T24), and backup and restore keep the new table, its grants and its ledger chain (T25).

## Non-goals (this spec)

Presentation or view telemetry (D02); medication events and treatment episodes (D03); endpoints (D04); consent, contract terms and release policy (D05); assay coverage and frequencies (D06); any analysis, aggregate or release (D07); phenoconversion (D08); specialty modules (D09 to D11); a UI (the local operations page shows evaluations as raw JSON today, and no decision UI is proposed here); real data, deployment, a model provider, billing, new infrastructure, a graph store.

## Alignment with the company roadmap (founder document, 2026-10-24)

The roadmap (*Telesphoros company roadmap and business model*, supplied 2026-10-27; not in the repository) was read for context. Where it touches this spec:

| Roadmap item | What this spec does with it |
| --- | --- |
| H1 gate "outcome recorded on 40% of recommendations"; kill criterion below 20% at nine months | This slice gives the **first numerator that can be measured honestly**: decisions recorded per eligible result. It is a **decision-capture rate, not an outcome rate**. An outcome needs D03 (what was ordered or taken) and D04 (what was observed). The gate metric needs a written definition (numerator, denominator `shown` results on active current evaluations, window) before it is reported. That is decision D8. |
| "Recommendations reviewed by a clinician before action: 100%" | A decision proves a clinician responded to a result. It does not prove review before action, or that every shown result was seen. That needs D02 presentation events. |
| "Decision and outcome captured, not just displayed" (value point 3) | D01b is the "decision" half. "What was ordered" is D03 and "what happened" is D04. Neither is inferred from a decision. |
| Manual-entry fallback that still captures the decision (reader risk) | The decision references a stored result. A manual-entry path would have to create an evaluation first. It is not in scope here. |
| Phenoconversion in H1 scope | D08 is a clinical-logic slice with its own validation note. It is not started here. |
| "Use PharmCAT as the engine" (H0/H1 decision table) | **Conflicts with the decision on record**: the in-house engine over pharmacist-signed knowledge stays the source of truth ("D1 = A", `docs/design/plans/pgx-data-model-and-data-products.md:7`; PharmCAT appears only under the gap analysis's option B, line 42). This spec does not depend on either engine; the conflict is for the founder. |
| "Under 70% of patients respond satisfactorily" | Not encoded anywhere. It stays a literature claim with its cited source; a response product needs drug, indication, endpoint and denominator (report section 2). |
| Consent for secondary use from the first patient; no row in a product without it | D05 is a hard prerequisite of D07. This slice stores no real data. |

## Historical-plan crosswalk

See [research.md section 4](research.md#4-historical-plans-what-is-superseded). The 2026-10-19 data-product plan and gap analysis are preserved unchanged and cited as history.
