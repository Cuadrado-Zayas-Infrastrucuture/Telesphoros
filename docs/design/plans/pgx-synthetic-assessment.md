# Synthetic assessment from stored structured revisions (032 S3)

Date: 2026-11-03
Status: Proposed plan, documentation only. Authorized by the founder's "Build spec 032 S3" and "Approved, start" (2026-11-03) for this plan PR. Nothing in this document is built, and the open decisions below are not settled by it.

## Why now

The MVP is scoped to task T-A: a staff member uploads a synthetic report, a second person reviews it, and the stored evaluation is shown (outcome, reason code, citation). The stored-result view already exists on the patient page (`PatientClinicalSections` > `ResultsList` > `StoredResult`). Nothing on staging can create an evaluation for it to show, because the lab-report pipeline and queued evaluation are refused under `NODE_ENV=production` (`docs/ops/environments.md`). Spec 032 slice S3 is the planned replacement: a contextual synthetic assessment generated from the stored structured revisions that S2 already persists.

## Findings that shape the slice (read on `origin/main` fa3d04cf, 2026-11-03)

1. **The existing evaluation path is PDF-shaped.** `EvaluationsService.store` needs an accepted capture, the report reader and `report.type === 'lab-pdf'`. The `evaluations` table has `capture_id uuid NOT NULL` and a `binding` built from text hashes and a poppler version. A structured revision has none of these.
2. **Only one caller may create evaluations.** `lab-reports/evaluation-gate.spec.ts` fails if any file other than `evaluations.service.ts` calls `insertEvaluation`. A second writer needs either a deliberate change to that test, reviewed on purpose, or a separate table.
3. **S2 is owned-local only today.** `StructuredPreviewService.assertEnabled` calls `assertLocalStorage`, which refuses `NODE_ENV=production`, requires `LOCAL_STORAGE_RUN_ID`, a loopback disposable database and a local S3 bucket. Patient-link review, the findings view and revision save are therefore not reachable on staging. S3 on staging needs an explicit decision to expose them there.
4. **Migrations 0068 and 0069 are not on staging.** `structured_report_revisions` (0068) and `structured_finding_reviews` (0069, S2c, PR #271) are marked `compat: breaking` (ledger writer and verifier rollout). `docs/ops/environments.md` records staging migrated through 0065 on 2026-10-31. The fence-close checker defect that blocked release 39713db5 is fixed on main (PR #269); whether a release has since gone out is unverified. S3's input is the reviewed findings from S2c, so the S3 migration is numbered after 0069 (0070 at `origin/main` fa3d04cf, re-checked at push time).
5. **Spec 024 D3 forbids interpretation on staging** ("there is no interpretation outside the local preview"). S3 needs that decision amended, by the founder.
6. **Content exists.** `data/fixtures/knowledge/synthetic/` holds five phenotype files and six guideline files (joint and single-gene cells). `knowledge/cpic` stays empty; no real guideline content is used.

## Decisions for the founder

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where S3 stores an assessment: (a) widen `evaluations` (nullable `capture_id`, a source kind, a structured binding), or (b) new append-only, ledger-covered assessment tables whose read model matches the summary shape the UI and clinician decisions already use. | (b), provided PR 2's first spike shows clinician decisions and follow-ups can bind to an assessment result without changing their rules. If they cannot, stop and re-plan. (a) edits a ledger table that every existing evaluation depends on. |
| D2 | Amend spec 024 D3 so staging may show synthetic-labelled interpretation. | Yes, scoped: every displayed assessment carries `synthetic-test-only`, `clinicalUse: not-approved`, and no recommendation wording that reads as a prescribing instruction. |
| D3 | Lift the owned-local-only gate on structured intake, findings view and patient-link review for the staging profile only. | Yes, behind a new explicit synthetic-staging profile flag that production refuses. Not by loosening `assertLocalStorage`. |
| D4 | Release order: ship the S2 migrations (0068, 0069) to staging before the S3 migration. | Yes. The S3 migration is additive and numbered after the current head at push time. |

## Proposed slices (each its own PR off main, never stacked, local until "push")

| PR | Scope | Gate |
| --- | --- | --- |
| 1 | This plan, plus the D2 amendment text for spec 024 as a proposal. Docs only. | Links resolve; guard tests that read docs pass; founder approves D1 to D4. |
| 2 | Server-side synthetic assessment from a stored revision: select the approved cell from complete findings, hold anything incomplete, conflicting or unsupported, never infer. Additive migration. Reads the existing synthetic knowledge fixtures. Cases A07, A08, A13, A19. | Real PostgreSQL and S3 tiers; independently written expected cells; each rule goes red when disabled; ledger walk clean. |
| 3 | Staging exposure (D3 profile flag) and the UI trigger and display. Medication-context rule (A12) and decision and follow-up binding (A18). | Browser walkthrough on desktop and mobile; production refusal test; no change to decision or follow-up rules. |

## Boundaries

Not touched: `PINNED_READER`, the production refusal of `LAB_REPORT_PIPELINE` and `EVALUATION_REQUESTS`, the report-adapter packet checks, clinician-decision and follow-up rules, Terraform and AWS, `knowledge/cpic`, and all real-data gates. No clinical release is implied. A14 (equivalent PDF, FHIR and chat renderings) is out of scope for the MVP and stays a later slice.

## Verification of this plan

This PR is documentation. Its claims were read from `origin/main` fa3d04cf and are re-checked at push time against `origin/main`, open PRs and the migrations directory. Unverified: whether decisions and follow-ups can bind to a non-`evaluations` result (PR 2 spike), and the staging image and migration level currently running.
