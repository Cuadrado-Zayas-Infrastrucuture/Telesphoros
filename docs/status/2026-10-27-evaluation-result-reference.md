# Feature: each evaluation result carries its stored id and ordinal (spec 006, D01a)

Date: 2026-10-27

The first slice of the decision-and-outcome data model (spec 006, plan approved by the founder on 2026-10-27). In `GET /evaluations/:id` and the create response, every result now carries `id` and `ordinal`:
- `id` is the stored `evaluation_results` row. It is database-generated and append-only, and the evaluation's ledger projection already hashed it (`apps/backend/src/ledger/projections.ts`).
- `ordinal` is the result's position from 0.

This lets the next slice record a clinician's decision about one exact result instead of a drug name or an array position.

Changed:
- `evaluationResultDtoSchema` in `packages/shared-types/src/lab-report.ts` (still strict).
- The evaluation mapper.
- The SMART pilot's test fixture, which builds a result DTO and now also asserts that the id is not exported into the FHIR bundle.

Not changed: migrations, the ledger projection, record hashes, the verifier, the engine, any knowledge file, the SMART pilot's export, and the frontend (it parses the shared schema and needed no edit).

Verified on real PostgreSQL 16 and the S3 emulator; counts and the mutation checks are in [the verification record](../verification/evaluation-result-reference.md). Local only until the founder says push.
