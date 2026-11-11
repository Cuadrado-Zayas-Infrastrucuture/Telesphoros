# Hand-built responses are checked against their strict schemas

Date: 2026-11-11

The security checklist review (2026-11-11) found five groups of endpoints whose responses were built by hand with no schema check: patient
medications, patient demographics, the structured preview (six routes), the patient-link decision, and the upload intake (state, declare,
bytes, resume, cancel). Nothing leaked, but nothing would have caught a field a service added by mistake.

Each now passes its result through a strict schema at the boundary, so an extra field is refused with a 500 instead of being sent. Strict
schemas already existed in `@telesphoros/shared-types` for all but the upload responses; `report-upload.ts` adds `uploadAttemptDtoSchema` and
`uploadStateDtoSchema`, and the frontend now uses the same attempt schema instead of its own copy. The upload attempt matters most: the stored
attempt holds its storage key, tenant, principal and digest, and the response may carry only its id, revision, state and expiry. The report's
own patient-link decision route (`POST /reports/:id/patient-link/decisions`), which returns the same decision, is checked the same way.

Proved:
- `apps/backend/src/common/response-schemas.spec.ts` (16 tests): each handler sends its service's result through the named schema and returns
  the schema's output; the intake service sends exactly the four attempt fields and refuses a run status or attempt state the schema does not
  know. Removing the schema from the medications list and from the upload state turned 3 of them red.
- `packages/shared-types/src/report-upload.test.ts`: the upload schemas accept what the API sends and refuse a storage key, tenant, principal,
  digest or extra run field (253 shared-types tests pass).
- The 48 backend suites that call these routes, on all three tiers, with no failure: 485 passed in memory, 678 on PostgreSQL, 784 on PostgreSQL
  with the S3 emulator. So every real response already fits its schema. Frontend lib tests 281/281; both apps typecheck.

No route, status code or response field changed for a correct response.
