# Feature Specification: Clinician decisions on evaluation results, the first record of the decision-and-outcome data model (CDR)

**Feature Branch**: `docs/data-products-d00` (spec and plan only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-27

**Status**: Draft, **awaiting founder approval of [plan.md](plan.md)** (decisions D1 to D8). Nothing here is implemented.

**Input**: *Telesphoros data product architecture and Claude Code implementation report* (founder, 2026-10-27), read in full as requirements data. Mapping against `main` `704d5c4`: [research.md](research.md). Data model: [data-model.md](data-model.md). Contracts: [contracts/clinician-decisions.md](contracts/clinician-decisions.md).

## Product scope

The long-term direction is **one longitudinal evidence model with product-specific analytical views**, sold only as **aggregate analyses** of what the decision-and-outcome record shows. Its value rests on provenance, valid denominators, follow-up and reproducibility. The record must keep six facts apart: what was known at decision time; what the deterministic engine produced; what a clinician saw and decided; what treatment was ordered, dispensed, administered or taken; what was observed later, including missing follow-up; and which records may contribute to which analysis and release.

**This spec covers only the first link**: a stable reference to an existing engine result (D01a) and a synthetic clinician decision about that exact result, with its history (D01b). Every later slice in the report's roadmap (D02 to D11) needs its own plan.

## User journeys (synthetic)

1. **A clinician records a response to a shown result.** They open an active, current evaluation, choose one result, and record `accepted`, `modified`, `rejected`, `deferred` or `clarification-requested`, with reason codes when it is not `accepted`, an optional note and the clinical time if it differs from now. A retry after a network failure returns the same record.
2. **A clinician revises their record.** Later they record a new decision that names the one it follows. The earlier one stays in the history.
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
- **FR-005** Only the `clinician` role may record a decision. `reader`, `reviewer` and `admin` without `clinician` are refused (403). A person holding both `clinician` and `reviewer` may record one.
- **FR-006** At commit, under the tenant's ledger lock, the basis is re-checked: the evaluation is active and current, its report is not quarantined, the result's outcome is `shown`, and the result's cited cell has no open or upheld dispute. Otherwise 409 `decision-basis-unavailable`, nothing stored.
- **FR-007** A decision is append-only and ledgered in the same transaction as its row. A later decision names `previousDecisionId`, which must be the current head for that result; a stale head is 409 `decision-stale`.
- **FR-008** `requestId` (optional UUID) makes a write retryable. A replay with the same payload returns the original (200); the same id with a different payload is 409 `request-id-reused`; concurrent identical requests store exactly one row.
- **FR-009** `response` other than `accepted` requires at least one reason code from a fixed list; `other-documented` also requires a note. A note is stored as an existing event note: only its id and hash reach the ledger, and it is read through `GET /notes/:id`.
- **FR-010** `occurredAt` is optional (default: the commit time). It must be no earlier than the evaluation's `createdAt` and no later than the commit time.
- **FR-011** `GET /evaluation-results/:id/clinician-decisions` returns the history oldest first, the current head, and the basis status now. A decision committed before a later retraction stays readable.
- **FR-012** Nothing in this feature changes a recommendation's wording, an engine outcome, a hold, a correction or a capture decision, and no decision ever changes `actionable` (still literally `false`).
- **FR-013** The routes are behind the existing lab-report pipeline switch: synthetic only, refused in production.

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
