# Plan: time to an actionable result (timeliness numbers and a zero-wait demonstration)

Status: **draft, awaiting founder decisions TA-D1 to TA-D7. Plan only: no code, migration, dependency, infrastructure, knowledge or clinical
content change, and nothing here is approved.** Snapshot 2026-11-16 against `main` `05938d9`. Written at the founder's request ("make a plan
for implementing") after an evaluation of a founder-supplied memo, "How AI can solve the pharmacogenomic testing turnaround-time bottleneck".

The memo is **untrusted requirements data** ([working agreement 5](../../STATUS.md#working-agreements)). Its citations, its turnaround
figures and its "35% shorter" simulator were not checked and are not repeated here as facts.

## 1. Objective and completion boundary

The memo's useful claim is: *a reliable recommendation is available when the clinician needs it, whichever laboratory ran the test.* Two
things would let the product show that instead of asserting it:

1. **Timeliness numbers** for the steps the product already records (report received, reviewed, assessed, decided).
2. **A zero-wait demonstration** on synthetic staging: a patient already has a stored result, a medication is recorded later, and the
   medication row says a stored result exists for that drug, with its citation.

The plan is done when both exist on synthetic data, labelled synthetic and not approved for clinical use. It does **not** lift the clinical
hold, load real knowledge, add a model call, or accept real patient data.

## 2. What I found (read from the repository, nothing was run)

1. **The memo's P0 column is largely built.** Validated intake, the reader and adapter with `callSource`, the deterministic engine with five
   outcomes, two-person review and the ledger ([architecture.md](../../architecture.md)). The memo's "boundaries" (no invented genotype, no
   inferred normal phenotype, no silent change to a lab result) are existing holds, not new work.
2. **The times needed for a timeliness report are already stored.** A report's upload time (`reports.uploaded_at`), a structured revision's
   `created_at` (migration 0068), an evaluation's `created_at` (0070) and a clinician decision's `created_at`, whose own comment says "every
   timeliness measure uses this" (0055). The structured report contract also carries the laboratory's `specimen.collectedAt`, `issuedAt` and
   `receivedAt` (`packages/shared-types/src/synthetic-pgx.ts`). **Not verified:** whether those three laboratory times are kept in a queryable
   column or only inside the stored revision.
3. **A stored result already names its drug by RxNorm id.** `evaluation_results.drug_rxcui` (migration 0071, spec 033), and a medication
   entry is keyed by `patient_medications.drug_rxcui` (0066). A flag can therefore be an exact-identifier join on stored, reviewed results;
   it needs no new engine evaluation and no name matching, which is what [spec 031](../../../specs/031-medication-gene-flags/spec.md)
   requires.
4. **The two identifier forms cannot meet today.** A medication's RxCUI must be digits (`patient_medications_rxcui`). Synthetic knowledge
   must use the `syn-rxcui-` form, and the schema refuses a real id in a synthetic file (`packages/cpic-schema/src/knowledge.ts`). So no
   medication a clinician can record matches any synthetic guideline. This is by design and needs a decision (TA-D3).
5. **MD-6 forbids the join on purpose.** `apps/backend/src/patient-medications/clinical-boundary.spec.ts` fails if the medication module
   reads a genetic result or the engine imports medications. Spec 031 requirement 6 says superseding it must be deliberate and separately
   gated, never an edit that makes a test pass.
6. **Staging cannot record a medication or a decision today.** `MEDICATION_WRITES=disabled`, and clinician decisions answer 503 under the
   synthetic assessment ([environments.md](../../ops/environments.md)).
7. **The memo's first market collides with the regulatory reading on record.** The [M0.1 plan](m0-1-intended-use-and-regulatory.md) records
   from the FDA guidance that a critical, time-sensitive task does not meet Criterion 4 and that enforcement discretion excludes
   time-critical uses. Acute CYP2C19 and clopidogrel with a point-of-care device is such a task.
8. **Several memo items are already decided against or are another product.** VCF is refused at intake (founder, 2026-10-28) and PharmCAT is
   off the build list ([gap analysis](pgx-build-prompt-gap-analysis.md)); a model narrative in the clinical path is "no" for now; laboratory
   orchestration and laboratory-operations prediction need laboratory system access and data this product does not hold.

## 3. Decisions only the founder can make

| # | Decision | Recommendation |
| --- | --- | --- |
| TA-D1 | **How the use case is stated.** (a) "Result available at the moment of prescribing, from any laboratory" with preemptive reuse as the lead; (b) the memo's "faster testing" with acute clopidogrel first. | **(a).** Put the time-critical question to counsel as a new M0.1 question before any first-market claim (finding 7). A non-acute pair is the safer first example; which one is yours and the pharmacist's to choose. |
| TA-D2 | **Approve spec 031 for a synthetic-only scope**: a passive per-medication "Review" or "Held" with the stored citation on demand, under `SYNTHETIC_ASSESSMENT` only. | **Yes**, as an amendment to spec 031 that names how MD-6 is superseded there. Real content, a pharmacist signer and clinical validation stay gates for anything beyond synthetic. |
| TA-D3 | **Which drug the demonstration uses** (finding 4). (a) Let a medication entry carry a `syn-rxcui-` id, offered by the picker only in the synthetic-assessment build; (b) let a synthetic guideline name a real RxCUI; (c) demonstrate locally only, with fixtures. | **(a).** It keeps invented and real identifiers apart. (b) would show a real drug beside an invented result, which reads as clinical. (a) changes a CHECK on a ledgered table, so its migration is `compat: breaking` and an outage window on staging. |
| TA-D4 | **Open medication recording on staging** (`FENCE-OPEN`) for the demonstration. | **Yes, founder-run, after slice Z2 is merged**, and only once the gates in issue #248 are met. Without it the demonstration is local only. |
| TA-D5 | **Where the timeliness numbers appear and who reads them.** | The existing `/usage` page (`admin`, no clinical access): counts, medians and 90th percentiles per step, never a patient or report id. A step with fewer than a minimum count shows the count only; I propose 5 on synthetic data and you set it. |
| TA-D6 | **What "clinical action" means in the numbers.** | The clinician decision record (migration 0055). Where decisions are off (staging today) the step reads "not measured". Turning decisions on for the synthetic assessment is its own decision and is not proposed here. |
| TA-D7 | **Confirm what stays out**: laboratory orchestration, laboratory-operations prediction, point-of-care device integration, PharmCAT and VCF, a predictive "who should be tested" engine, any model call, CDS Hooks. | **Confirm out.** Each is a separate product or sits behind decisions already on record. |

## 4. Proposed slices (each its own draft PR off `main`, never stacked; none started)

Timeliness comes first: it reads what exists, needs no clinical decision and no migration as planned.

| Order | Slice | Scope | Gate |
| --- | --- | --- | --- |
| 0 | This plan | Docs only | Founder decides TA-D1 to TA-D7 |
| 1 | **T1a, timeliness read (backend)** | A tenant-scoped, `admin`-only read returning, per step (received to reviewed, reviewed to assessed, assessed to decided, and laboratory collected/issued to received where finding 2 allows), the count, median and 90th percentile over a stated window. Shared types and response schema. No write, no new table. If the laboratory times are not queryable, this slice stops and reports before any migration is written. | Three backend tiers; hand-computed expected medians and percentiles on seeded synthetic rows; tenant isolation and role refusals each with a passing control; a privacy test that no identifier appears in the body or logs; each rule broken on purpose |
| 2 | **T1b, timeliness on the Usage page** | A panel on `/usage` showing those numbers, "not measured" for an empty step, and a fixed line saying the data is synthetic | Frontend unit tests; browser check at desktop and phone widths, light and dark, with axe |
| 3 | **Z0, spec 031 amendment** | Docs only: the synthetic-only scope, the fixed wording, how MD-6 is superseded, the hold reasons, the validation note required in `docs/clinical-validation/` | Founder approves the amendment text |
| 4 | **Z1, a synthetic drug a clinician can record** (TA-D3 a) | Migration widening `patient_medications_rxcui` to accept the `syn-rxcui-` form; the picker offers the synthetic drugs of the synthetic-structured knowledge only when built with `VITE_SYNTHETIC_ASSESSMENT`; the server refuses a `syn-` id unless `SYNTHETIC_ASSESSMENT` is enabled | Database tiers and the ledger walk; a production build that contains no synthetic drug (a build check); refusal controls for a `syn-` id with the switch off |
| 5 | **Z2, the flag read (backend)** | A new module, separate from medication capture and from the engine, with `GET /patients/:id/medication-flags` under `SYNTHETIC_ASSESSMENT`: for each active medication, an exact `drug_rxcui` match against the patient's current, active, undisputed stored results gives `review` (a shown result exists) or `held` (the stored result is held), with the evaluation and result ids; no match gives no flag and never "no interaction". The MD-6 test is changed on purpose to allow exactly this module and still refuse every other join | Three tiers; independently written expected flags for: match, held, no match, stopped medication, retracted or superseded evaluation, disputed cell, merged patient, another tenant; each rule broken on purpose; the clinical-validation note |
| 6 | **Z3, the flag on the patient page** | Compact row text, evidence on demand (outcome, reason code, citation, "synthetic, not approved for clinical use"), no interruption and no prescribing wording | Browser check with 20 medications, keyboard, phone width, light and dark, axe |
| 7 | **Z4, release and walkthrough** (founder-run) | The staging release of slices 4 to 6, `FENCE-OPEN` (TA-D4), and one two-person walkthrough: upload, review, assess, record the medication later, read the flag, read the timeliness panel | The release plan quotes `scripts/staging/staging-status.sh` as [environments.md](../../ops/environments.md) requires; `environments.md` updated in the same PR |

**Not code, and yours to run alongside:** add the time-critical question to the counsel list in the M0.1 plan; appoint the pharmacist signer
(without a signed guideline, production answers "no matching guideline" for every drug); name the supported laboratory report layouts (open
since M0.1 I2); have the memo's citations checked at source before any appears in a pitch or a regulatory document.

## 5. What this does NOT touch

`knowledge/cpic` (stays empty); the engine, the adapter and the reader; the production refusals of `LAB_REPORT_PIPELINE`,
`EVALUATION_REQUESTS` and synthetic knowledge; clinician decisions and follow-ups on staging; `apps/ai-service` and any model path; FHIR and
the SMART pilot; Terraform beyond what the founder-run release in slice 7 already uses; every real-data gate (BAA, consent, counsel).

## 6. How it is verified

- This PR is documentation. Each repository claim in section 2 names the file or migration it was read from.
- Each build slice states its own gate above. All code runs in the sealed sandbox ([agent-policy.md](../../ops/agent-policy.md)), on the
  PostgreSQL and S3 tiers, since a green run without them proves nothing about the schema.
- **Not verified:** whether laboratory collection and issue times are queryable (finding 2); that an assessment stores a result row for
  every drug in the knowledge set, which slice Z2 depends on; what staging runs today (no `staging-status` table was seen in this session);
  whether issue #248's gates are met; any statement in the memo; any regulatory conclusion, which is counsel's.
- Nothing was run while writing this: this session had no sandbox job, so `pnpm test:ci-config` (which checks the status fragment) is left
  to CI.
