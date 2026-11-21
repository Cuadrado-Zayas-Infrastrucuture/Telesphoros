# Plan: spec 044, slice A, the read

**Status**: **approved by the founder on 2026-11-21**, with P1 and P2 decided (below). Plan only. Spec 044 itself was approved by the founder on 2026-11-21 ("Approved").
Read against `main` at `7f5f3cf`.

## Amended during implementation (2026-11-21)

- **`drugRxcui` is not added to the evaluation DTO in slice A** (item 1 below, and the first row of "Touched"). The frontend parses
  evaluations with strict schemas (`clinicianDecisions.ts`, `StructuredAssessment.tsx`), so a new field on the DTO would make an older
  frontend refuse every evaluation response for as long as a release runs the new API beside the old frontend. Instead
  `EvaluationsService.currentForPatient` returns each current evaluation's DTO **beside** a map of the RxCUI each stored result carries, read
  from the same records; the evaluation responses are unchanged. Founder decision B-D3 (2026-11-21, slice B plan) then dropped `drugRxcui` from the DTO altogether: the screen gets what it needs from this route. The
  mapper (`lab-report.mapper.ts`) is therefore not touched.
- **Rule 2, said exactly:** only sources that resolved the gene are compared. A source that could not resolve it, beside one that did, is
  listed and does not make a conflict.
- **Combination products** are matched only by a guideline stating the combination's own RxCUI (spec 039 D2). A combination medication
  therefore reads `no-guideline-loaded` even when a guideline for one of its ingredients is loaded. How slice B shows that is a founder
  decision, recorded in `docs/clinical-validation/genomic-profile-read.md`.

## What slice A delivers

1. **`drugRxcui` on every result the API returns.** `evaluationResultDtoSchema` gains `drugRxcui: string | null`. The value is already read
   from `evaluation_results.drug_rxcui` (`ledger/projections.ts:486`, `drugRxcui` on the record) and dropped by the mapper
   (`lab-reports/lab-report.mapper.ts`). Results from schema 1.2 knowledge answer `null`. The evaluation pages ignore the field until slice B.
2. **`GET /patients/:id/genomic-profile`**, optional `?rxcui=` (spec 044 D7), in a new module `apps/backend/src/genomic-profile/`.
3. **The MD-6 boundary test, replaced** (spec 044 D8).

## Touched

| Path | Change |
| --- | --- |
| `packages/shared-types/src/lab-report.ts` | `drugRxcui` on `evaluationResultDtoSchema`, nullable |
| `packages/shared-types/src/genomic-profile.ts` (new), its index export | `genomicProfileQuerySchema` (`rxcui`: the medication schema's RxCUI form, optional) and `genomicProfileDtoSchema` (below) |
| `apps/backend/src/lab-reports/lab-report.mapper.ts` | Map `drugRxcui` |
| `apps/backend/src/genomic-profile/` (new): module, controller, service, specs | The route and the pure profile builder |
| `apps/backend/src/app.module.ts` | Register the module |
| `apps/backend/src/patient-medications/clinical-boundary.spec.ts` | D8: the boundary rule below |
| `apps/backend/src/common/response-schemas.spec.ts` (if it lists routes) | The new route's response schema |
| `docs/status/YYYY-MM-DD-genomic-profile-read.md`, `docs/clinical-validation/genomic-profile-read.md` | Status fragment; validation note (CONTRIBUTING: clinical logic needs one) |

## Not touched

No migration, no SQL change, no knowledge file, no engine, adapter, reader or loader code, no frontend, no Terraform. No write path of any kind.
`LAB_REPORT_PIPELINE`, `SYNTHETIC_ASSESSMENT`, `MEDICATION_WRITES` and `FOLLOWUP_WRITES` keep their meaning. The clinical hold, `clinicalUse:
"not-approved"` and `actionable: false` are unchanged and are carried on the response.

## The route

- **Gate:** the same as `GET /evaluations`: `EvaluationReadGateGuard` (pipeline or synthetic assessment on, PostgreSQL ledger present);
  otherwise 503, as the evaluation list answers. On staging today it answers; in a build with both off it is 503, and slice B says so.
- **Roles:** `reader`, `clinician`, `reviewer` (spec 044 D7, G4 as proposed). `admin` alone is 403, as on every clinical route.
- **Tenancy:** the patient is read with the caller's tenant; unknown or foreign is 404, a merged-away patient is 404 naming no target.
- **Reads, in this order:** the patient; every **current** evaluation of the patient (`evaluationPage` with `patientId` and `current`,
  paged at the list's maximum, at most 10 pages, and `capped: true` beyond); the patient's **current, active** medications (the existing
  medications read, which works with `MEDICATION_WRITES` off). Nothing else. No engine call, no knowledge read except the loaded set id the
  evaluation list already uses for its advisory.
- **Logging:** none of the route's values; errors use the existing fixed codes (spec 044 GP-8).

## The response (`genomicProfileDtoSchema`)

```
patientId, clinicalUse: "not-approved", capped: boolean,
genes: [{ gene, status: "resolved" | "conflict" | "not-resolved",
          sources: [{ evaluationId, reportId, evaluatedAt, state, phenotype, diplotype, activityScore, reasonCode }] }],
awaitingLinkReview: [{ evaluationId, reportId }],
medications: [Check],          // one per current active medication, list order
check: Check | null            // with ?rxcui=, else null
Check = { rxcui, name | null, word: "review" | "held" | "no-recommendation" | "no-guideline-loaded",
          knowledgeChanged: boolean, conflict: boolean,
          results: [{ evaluationId, resultId, outcome, reasonCode, strength, recommendationText, implication, citation, genes }] }
```

The server returns the **word**, not wording: the sentences are the frontend's, so the founders can set them (G3) without an API change.
`name` is the medication's stored name for a medication and `null` for a `?rxcui=` check (the frontend shows the name it picked).

## Rules the builder applies (pure function, unit-tested)

1. **Profile inputs (D2):** only evaluations that are current, `state: active` and `advisory.patientLink: verified`. `unverified` go to
   `awaitingLinkReview` and nowhere else; `rejected` are dropped (a quarantined report has no current evaluation already, M2.1c).
2. **A gene's status:** `resolved` when every source gives the same phenotype (or the same activity score where that is what the map uses);
   `conflict` when two sources differ; `not-resolved` when every source names the gene and none resolved it. A gene no source names is absent:
   slice B writes "Not tested" only for genes the medication results name.
3. **Matching (D3):** a result matches a medication when `result.drugRxcui === medication.rxcui`, strict string equality. `null` never matches.
4. **The word (D4), over every matching result from rule 1's evaluations:** `review` if any is `shown`; else `held` if any is `held`; else
   `no-recommendation` if any is `abstained` or `no-published-recommendation`; else `no-guideline-loaded`. **Every matching result is listed**,
   so a `held` beside a `shown` is visible. **Decision P1 below** asks the founders to confirm this order.
5. **`conflict` on a check:** true when any gene a matching result used has status `conflict`.
6. **`knowledgeChanged`:** true when any matching result's evaluation has the knowledge-change advisory `changed` (the evaluation list's
   existing computation). For `no-guideline-loaded` it is true when any current evaluation's advisory is `changed`, because the loaded set may
   have gained the drug.

## The MD-6 rule after slice A (D8)

`clinical-boundary.spec.ts` keeps both of its tests and adds a third:

- unchanged: the engine (`services/`), `lab-reports/` and the ledger verifier import nothing from the medication module;
- unchanged: the medication module reads no genetic result;
- new: **only `src/genomic-profile/` imports both** the medication module and an evaluation read; any other file that does fails the test.
  The genomic-profile module is itself checked to import no engine, adapter, reader or loader code.

## Tests (working agreement 6: every refusal has a control, every rule is broken once to watch a test fail)

- **Builder unit tests** for rules 1 to 6, from hand-written expectations: a `verified` and an `unverified` evaluation; two sources with
  different phenotypes; a name-equal, RxCUI-different medication (GP-4); a `syn-rxcui-` result beside a real RxCUI medication (GP-6); a `held`
  beside a `shown`; schema 1.2 results with `null`; an empty knowledge set (GP-10). Each rule is removed in turn and a test must fail.
- **Text test (GP-5):** the builder's output and the response schema contain no other word; slice B repeats it on rendered text.
- **Route tests in the three tiers** (memory, PostgreSQL, PostgreSQL plus S3): roles, tenant isolation (two tenants, same RxCUI), 404s,
  gate 503 with both switches off, `capped`, and that the route performs no write (GP-7: the repositories' write methods are spied and never
  called; the ledger's event count is unchanged).
- **Mapper test:** `drugRxcui` is present for schema 1.3 results and `null` for 1.2; the evaluation list and detail validate against the
  updated schema.
- **Boundary test:** the new third rule, proved by a temporary import that makes it fail.

## How it will be verified, and the constraint on running it

Agent policy runs code only inside the sealed `opensandbox-pilot` sandbox ([agent-policy.md](../../docs/ops/agent-policy.md)). **This
cloud session has no such sandbox.** So implementation needs one of: a session on the founder's machine with the pilot, or the founder's
decision on where this session may run code. Without that, the code can be written here but not run, and a pull request would say every
check is unrun until CI. CI runs `verify` and the database tiers on the pull request once it is marked ready.

## Decisions for the founders

- **P1. The word when results disagree** (rule 4): **decided 2026-11-21 (founder), as recommended:** Review before Held before No
  recommendation, with every result listed, because a held result in one report does not erase guidance from another verified one.
- **P2. Where code may run** for this slice: **decided 2026-11-21 (founder): "write it here and let CI test".** The code is written in
  this cloud session and **not run here**: no test, build, type check or linter runs on this host, as agent policy requires. CI is the
  first run, and the pull request says so.

Not reopened here: G2 (the first pairs) and G3 (the wording) belong to slices K and B.
