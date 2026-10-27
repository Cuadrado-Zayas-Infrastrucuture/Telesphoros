# Contracts: result reference and clinician result decisions

All routes are under `/api/v1`, behind the lab-report pipeline switch (`@RequiresPipeline()`), tenant-scoped, and use the error envelope in `packages/shared-types/src/errors.ts`. Every example is synthetic.

## D01a: result reference (additive DTO change)

`evaluationResultDtoSchema` (`packages/shared-types/src/lab-report.ts:140`) gains two fields; nothing else changes.

```jsonc
{
  "id": "6f1c2a9e-0b7d-4c3e-9a51-2d8e4f6a7b10",   // evaluation_results.id, already in the ledger projection
  "ordinal": 0,                                  // position within the evaluation, from 0
  "drug": "synthetic-drug-a", "genes": ["CYP2C19"], "outcome": "shown", "...": "unchanged"
}
```

Compatibility: the schema stays strict. The three in-repository parsers (`apps/frontend/src/pages/LocalOperationsPage.tsx`, `LocalReviewPage.tsx`, `packages/smart-pilot/src/stored-pgx.ts`) use the shared schema and change with it. A bundle built before the change would refuse the new fields; no such bundle is deployed (nothing is). Stored projections, ledger hashes and the verifier are untouched.

## D01b: `POST /evaluation-results/:resultId/clinician-decisions`

Role: `clinician` (checked by `@Roles` and again in the database from the live membership row). Body (strict):

```jsonc
{
  "requestId": "uuid",                // REQUIRED: generate once per intended entry, keep it across retries
  "evaluationId": "uuid",             // must equal the result's evaluation
  "patientId": "uuid",                // must equal that evaluation's patient
  "entryKind": "decision",            // decision | amendment | entered-in-error
  "previousEntryId": null,            // the current head; null only for a result's first entry
  "response": "deferred",             // required unless entryKind is entered-in-error
  "detailCodes": ["pending-test-result"], // vocabulary cdr-v1; the response decides which are allowed and required
  "reviewBy": "2026-11-10",           // deferred only, optional
  "note": "optional, 1-1000 chars",   // required with any *-other code
  "occurredAt": "2026-10-27T14:05:00.000Z" // optional; omit to mean "now" (then occurredAtSource = recorded)
}
```

| Case | Status | Code / reason |
| --- | --- | --- |
| Stored | 201 | `ClinicianDecisionDto` |
| Replay: same `requestId`, same canonical request | 200 | the original `ClinicianDecisionDto`, even if the basis has changed since |
| Same `requestId`, different request | 409 | `CONFLICT` / `request-id-reused` |
| `requestId` missing | 400 | `VALIDATION_ERROR` |
| Result in another tenant, or no such result | 404 | `NOT_FOUND` (no disclosure) |
| `evaluationId` or `patientId` does not match the stored relationship | 409 | `CONFLICT` / `decision-binding-mismatch` |
| Basis not eligible at commit (policy `cdr-eligibility-v1`) | 409 | `CONFLICT` / `decision-basis-unavailable` |
| `previousEntryId` is not the current head (or is null when an entry exists) | 409 | `CONFLICT` / `decision-stale` |
| `amendment` or `entered-in-error` of another clinician's entry | 403 | `FORBIDDEN` / `not-entry-author` |
| Response, code, review date, note or time rule broken | 400 | `VALIDATION_ERROR` |
| Role not `clinician`, or membership not current | 403 | `FORBIDDEN` |
| Pipeline off or production | as today for `@RequiresPipeline()` | |

The idempotency scope is (tenant, author, `requestId`) for this operation only. A replay returns the stored record before any eligibility check, so a retry after a retraction still finds its original rather than being refused.

## `GET /evaluation-results/:resultId/clinician-decisions`

Roles: `CLINICAL_READ_ROLES` (reader, clinician, reviewer).

```jsonc
{
  "resultId": "uuid", "evaluationId": "uuid", "patientId": "uuid",
  "basis": ["active"],              // or any of: retracted, superseded, quarantined, disputed, not-current
  "headEntryId": "uuid|null",
  "currentDecisionId": "uuid|null", // the newest decision still standing (section 4 of data-model.md)
  "entries": [ /* ClinicianDecisionDto, oldest first, every author kept */ ],
  "clinicalUse": "not-approved", "actionable": false
}
```

## `ClinicianDecisionDto`

```jsonc
{
  "id": "uuid", "resultId": "uuid", "evaluationId": "uuid", "patientId": "uuid",
  "entryKind": "decision", "previousEntryId": "uuid|null",
  "response": "deferred", "detailCodes": ["pending-test-result"], "reviewBy": "2026-11-10",
  "vocabularyVersion": "cdr-v1", "eligibilityPolicy": "cdr-eligibility-v1",
  "note": { "id": "uuid", "bodySha256": "64 hex" },   // or null; body via GET /notes/:id
  "occurredAt": "timestamp", "occurredAtSource": "reported", "createdAt": "timestamp",
  "createdBy": "sub", "authorRoles": ["clinician"]
}
```

No field says or implies that a recommendation was presented, ordered, dispensed, administered or taken.

## Ledger event

Type `clinician-result-decision`, subject table `clinician_result_decisions`, payload = the projection hash (no free text, no note body).
