# Synthetic OpenEMR workflow acceptance — 2026-10-11

The planned synthetic integration sequence now has a repeatable, real-EHR acceptance command. This is engineering evidence for the local synthetic pilot, not clinical validation or production approval. See the [plan](../design/plans/synthetic-workflow-acceptance.md) and [runbook](../ops/synthetic-workflow-acceptance.md).

## Executed environment and result

Main base `9c66493` (#76), Node 22.22.0, local OpenEMR 8.4.1 with the existing UUID corrections, headless installed Chrome, PostgreSQL 16 under the restricted application role, versioned Moto S3, signed fake-provider backend identities, recorded D01 capture runner and test knowledge. The real EHR handles SMART OAuth/PKCE; neither evidence responses nor browser clocks are mocked. The viewer's existing CSP stays enabled. Native blob revocation is observed; PDF bytes are checked through the browser's actual download event.

The clean workflow passed in **43.03 seconds** after the deliberate defect below was restored. All ten browser phases passed:

| Browser phase | Backend GET requests | Evaluation/ledger counts |
| --- | ---: | --- |
| Actual chart launch, versioned FHIR, exact D01 PDF download | 10 | Unchanged |
| Browser offline: clear evidence and revoke blob | 0 | Unchanged |
| Online: fresh evidence/PDF recovery | 10 | Unchanged |
| Actual retraction, observed by normal periodic recheck | 9 | Unchanged |
| Independent reinstatement and explicit recheck | 10 | Unchanged |
| Supersession: old selection withheld, replacement not substituted | 9 | Unchanged |
| Explicit replacement selection and new chart launch | 10 | Unchanged |
| Object overwritten with D02: original pinned D01 still downloaded | 10 | Unchanged |
| Pinned D01 version removed: unavailable, no history/FHIR/profile/PDF fallback | 6 | Unchanged |
| Second unconsented chart: no stored evidence reads | 0 | Unchanged |

Fixture creation, capture acceptance, evaluations and reviewer corrections are separate setup writes to the fresh synthetic database. Actual connector transport observations require GET for EHR/backend/PDF reads; OAuth token POSTs are counted separately. The starting positive control requires observed EHR/API/PDF traffic, and every subsequent online evidence operation requires actual backend requests. Retained static registration fixtures make unintended fallback detectable. The second chart's selected FHIR identity is checked explicitly, and its genomic consent gate prevents any stored-reader request.

## Other verification

- `pnpm typecheck` and `pnpm lint`: passed across the workspace.
- Pilot build: passed, and that built router/reader/viewer was used by the real workflow.
- Pilot Vitest suite: **186 passed**, including six new fail-closed workflow preflight cases.
- Existing `stored-pgx-preview.pg-spec.ts`, real PostgreSQL plus S3 tier: **8 passed**, including tenant/patient/credential refusals, pipeline-off, disputes, correction state and pinned-source version behavior.
- Defect injection: removed the native `URL.revokeObjectURL` call only from the ignored generated viewer asset. Initial launch/download succeeded; the new workflow failed specifically at offline clearing. Restored the asset in `finally`, rebuilt, and reran the entire workflow successfully. No tracked application source was mutated.
- Staged diff: whitespace check and redacted Gitleaks scan passed.

The initial harness needed OpenEMR's actual search button and explicit OAuth form controls, plus the real download path rather than a CSP-blocked blob fetch. Those were harness repairs; no production or pilot behavior change was needed. The standalone local pilot was restored afterward using its unchanged private registration and reader configuration.

## Local evidence and portable entry points

These are real workstation links, not GitHub-hosted artifacts. Temporary logs may disappear after local cleanup. The aggregate manifest records Git HEAD and a dirty-worktree flag; these runs are working-tree evidence, not a claim of exact-commit CI completion.

- [Clean workflow log](/private/tmp/openemr-workflow-clean.log)
- [Revocation defect log](/private/tmp/openemr-revocation-mutation.log)
- [Pilot test log](/private/tmp/openemr-pilot-tests.log)
- [PostgreSQL/S3 reader test log](/private/tmp/openemr-stored-reader-tests.log)
- Aggregate workflow manifest (`<task workspace>/telesphoros-remastered-smart-pilot/packages/smart-pilot/openemr/.runtime/workflow-verification.json`)
- Portable sources: [workflow suite](../../apps/backend/test/workflow/openemr.workflow.ts), [browser driver](../../packages/smart-pilot/openemr/workflow-browser.mjs), [launcher](../../packages/smart-pilot/openemr/verify-workflow.cjs).

## Limits

The new real-OpenEMR command is opt-in local acceptance, not a new CI job. Existing CI checks/deadlines/assertions are unchanged; the ordinary pilot suite runs its preflight refusal checks. This slice did not rerun the entire backend matrix locally; the focused real PostgreSQL/S3 reader suite and complete real workflow were run. The workflow uses core R4 schema and finite terminology checks; the separate official IG validator remains responsible for the published-profile examples.

No production application source, database schema, retention setting, clinical gate, infrastructure or deployment changes. Test databases are removed; generated synthetic Moto buckets follow the existing emulator helper lifecycle. No real data, AWS enforcement, hosted Cognito, general PDF extraction, clinical knowledge validation or production SMART authorization is established. Polling/freshness limits, explicit selection and clinical release prerequisites remain as documented in the runbook.
