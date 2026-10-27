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

Role: `clinician`. Body (strict):

```jsonc
{
  "evaluationId": "uuid",          // must equal the result's evaluation
  "patientId": "uuid",             // must equal that evaluation's patient
  "response": "rejected",          // accepted | modified | rejected | deferred | clarification-requested
  "reasonCodes": ["patient-preference"],
  "note": "optional, 1-1000 chars",  // required when reasonCodes has other-documented
  "occurredAt": "2026-10-27T14:05:00.000Z", // optional
  "previousDecisionId": null,      // the current head when revising; null for the first
  "requestId": "uuid"              // optional retry identity
}
```

| Case | Status | Code / reason |
| --- | --- | --- |
| Stored | 201 | body: `ClinicianDecisionDto` |
| Replay, same `requestId` and payload | 200 | the original `ClinicianDecisionDto` |
| Same `requestId`, different payload | 409 | `CONFLICT` / `request-id-reused` |
| Result in another tenant, or no such result | 404 | `NOT_FOUND` (no disclosure) |
| `evaluationId` or `patientId` does not match | 409 | `CONFLICT` / `decision-binding-mismatch` |
| Basis not eligible at commit | 409 | `CONFLICT` / `decision-basis-unavailable` |
| `previousDecisionId` not the current head | 409 | `CONFLICT` / `decision-stale` |
| Reason, note or time rule broken | 400 | `VALIDATION_ERROR` |
| Role not `clinician` | 403 | `FORBIDDEN` |
| Pipeline off or production | as today for `@RequiresPipeline()` | |

## `GET /evaluation-results/:resultId/clinician-decisions`

Roles: `CLINICAL_READ_ROLES` (reader, clinician, reviewer).

```jsonc
{
  "resultId": "uuid", "evaluationId": "uuid", "patientId": "uuid",
  "basis": ["active"],             // or any of: retracted, superseded, quarantined, disputed, not-current
  "currentDecisionId": "uuid|null",
  "decisions": [ /* ClinicianDecisionDto, oldest first */ ],
  "clinicalUse": "not-approved", "actionable": false
}
```

## `ClinicianDecisionDto`

```jsonc
{
  "id": "uuid", "resultId": "uuid", "evaluationId": "uuid", "patientId": "uuid",
  "response": "rejected", "reasonCodes": ["patient-preference"],
  "note": { "id": "uuid", "bodySha256": "64 hex" } ,   // or null; body via GET /notes/:id
  "occurredAt": "timestamp", "createdAt": "timestamp", "createdBy": "sub",
  "previousDecisionId": "uuid|null"
}
```

## Ledger event

Type `clinician-result-decision`, subject table `clinician_result_decisions`, payload = the projection hash (no free text, no note body).
