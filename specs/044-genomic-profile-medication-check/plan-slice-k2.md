# Plan: spec 044, slice K2, real guidance for synthetic patients on synthetic staging

**Status**: **approved by the founder on 2026-11-21**: K2-D4 option a, and K2-D1, K2-D2, K2-D3 (English) and K2-D5 as recommended
(section 6). Plan only: no code, knowledge file, Terraform or clinical hold changes. Read against
`main` at `ef7f8eb` on 2026-11-21. Follows [the slice K plan](plan-slice-k.md): K-D1 decided as option a, K-D3 (phenotype-only gene maps)
decided yes. The first set is **simvastatin alone**: clopidogrel was chosen, then deferred under K2-D4 (section 2).

## 1. What K2 makes possible

On synthetic staging, a fictional patient's reviewed structured report is assessed against the **signed, real CPIC set** from K1, so the
genomic profile (spec 044) shows real guideline wording, "Review", for that patient's real-coded medication. It is the first demonstration,
and the first usability session, in which the screens mean something clinically. It remains synthetic: invented patients, invented
laboratories, `clinicalUse: "not-approved"`, no real patient data, and every release gate closed.

## 2. Read this first: clopidogrel does not fit the knowledge format yet (decision K2-D4)

CPIC's clopidogrel recommendations differ by **indication**, cardiovascular or neurovascular (spec 032's coverage table, row C01: "verify
exact indication"). The knowledge format has no indication or population field (`packages/cpic-schema`), and the loader allows **one
guideline per drug and set of genes**, so the two tables cannot both load. Medications record no indication either (spec 029). Loading
one table would show cardiovascular guidance for a patient treated for a neurovascular indication, or the reverse.

| Option | What it means | For | Against |
| --- | --- | --- | --- |
| **a. Simvastatin first; clopidogrel after an indication design** | K1 signs simvastatin and SLCO1B1 alone. Clopidogrel waits for a format change (an indication on a guideline, more than one guideline per drug and genes when their indications differ) and for medications to record an indication, with a hold when none is recorded | Nothing ambiguous is ever shown | Clopidogrel, the best-known pair, comes later |
| b. Clopidogrel, one indication, held without it | Sign one indication's table, and hold every clopidogrel result unless the indication is recorded and matches | Clopidogrel sooner | Still needs medications to record an indication, and a hold rule the engine does not have: most of option a's work for half the coverage |
| c. Clopidogrel as it is | Load one table and say nothing | none | Wrong guidance for some patients. Not acceptable |

**Recommendation: a.** Simvastatin fits the format as it is: one gene, recommendations keyed on the SLCO1B1 phenotype alone, with the dose in
the wording rather than in the lookup. The indication design becomes its own spec, which the next pairs (proton pump inhibitors, the
tricyclics) need as well (coverage rows C03 and C06).

## 3. What changes, against spec 032's synthetic assessment

### 3.1 Which knowledge the assessment reads (K2-D1)

Today the assessment reads only `SYNTHETIC_KNOWLEDGE_DIR`, and `syntheticKnowledgeFactory` refuses the start if any file is not synthetic.

**Proposed:** a new setting, `ASSESSMENT_KNOWLEDGE`, `synthetic` (default) or `signed`. With `signed`, the assessment reads
`SIGNED_KNOWLEDGE_DIR` instead, loaded under the **production rules**: reviewed, non-synthetic, schema 1.3, two valid signatures from
`KNOWLEDGE_SIGNER_KEYS`, not empty. **One set at a time, never mixed**, so an invented drug and a real one never sit in one evaluation.
Switching sets makes every earlier evaluation read "Guidelines changed" through the existing knowledge advisory, which is the honest
answer.

Configuration refuses `signed` without `SYNTHETIC_ASSESSMENT=enabled`, without `KNOWLEDGE_SIGNER_KEYS`, beside the lab-report pipeline, and
in a disposable local run, as the switch's other checks already do (`config/env.ts`). The image copies `knowledge/cpic/` to its own path,
as it copies the synthetic set today.

### 3.2 How a phenotype enters the engine (K2-D2)

`planStructuredAssessment` sends only a resolved **diplotype**, and says on purpose that "the laboratory's own phenotype is never used in
place of the knowledge set's mapping from the diplotype". With K-D3's phenotype-only maps there is no such mapping, so every structured
report would hold as `no-phenotype-mapping`.

**Proposed rule, narrow:** a finding's `laboratoryInterpretation.phenotype` is the engine's input **only when** all of these hold:

1. the gene's map in the loaded set is **phenotype-only** (no alleles, no method). Where a map can turn the diplotype into a phenotype, the
   diplotype is used as today and the laboratory's phenotype is ignored, so the rule above still stands wherever it can apply;
2. the finding is resolved and a second person accepted it, as every finding must be today;
3. the phenotype is **exactly one of the map's canonical terms**: no translation, no case folding, no synonym. Anything else holds;
4. the laboratory's `translationVersion` and the fact that the phenotype was lab-reported are stored in the evaluation's binding, so the
   ledger says which input was used.

Holds use the existing reason codes wherever one fits; the vocabulary is frozen, so a new code would be its own decision.

### 3.3 Fixtures

New synthetic structured packages: invented patients and laboratories (`syn-` ids, as today), **real gene names and phenotype terms** as
K1's signed maps define them (SLCO1B1 first), and one real-coded medication per case. Cases, each with a hand-written expected outcome:
every SLCO1B1 phenotype in the signed table; a phenotype not in the map; a diplotype only; an unreviewed finding; a conflict between two
sources; a medication with no guideline. They replace nothing: the existing synthetic set and its tests stay.

### 3.4 What people see

Every assessment and profile made with `signed` knowledge says, in place of today's synthetic label: **"Real CPIC guideline wording.
Fictional patient. Not approved for clinical use."** The data origin stays `synthetic` and `clinicalUse` stays `not-approved`. The stored
evaluation's scope names the set used (for example `synthetic-patient-signed-knowledge`), so the two kinds can never be confused in the
ledger or on screen. The wording is the founders' (K2-D3).

### 3.5 Switching it on and off

A Terraform variable in the synthetic profile only, off by default, as `synthetic_assessment_enabled` is. Two release modes, like
`ASSESSMENT-ON` and `ASSESSMENT-OFF`, to move between `signed` and `synthetic`, with the move back rehearsed once before the first
usability session. The founder applies; an agent only prepares.

## 4. Slices (each its own pull request off `main`)

| Slice | What | Depends on |
| --- | --- | --- |
| K2a | Knowledge selection (3.1) and the phenotype rule (3.2), backend only, with tests on synthetic *and* on test-only signed fixtures (keys generated in the test, never real) | K2-D1, K2-D2 |
| K2b | The fixtures (3.3) | K1's signed SLCO1B1 map, for the exact phenotype terms |
| K2c | The label (3.4) | K2-D3 |
| K2d | Image, Terraform variable and release modes (3.5) | K2a; the founder's apply, and K1's keys applied |

K2a and K2c can start before K1 is signed; K2b and K2d need it.

## 5. Tests

- Configuration: each refusal in 3.1 with its control.
- Loading: `signed` with a synthetic file, an unsigned file, one signature, a wrong key or an empty folder each stops the start; a valid
  test-signed set loads.
- The phenotype rule: each of its four conditions removed in turn must change the outcome (defect injection), and a map with alleles must
  still use the diplotype and ignore the laboratory's phenotype.
- End to end on PostgreSQL and S3: a fixture patient with a real-coded simvastatin medication reads `review` in the genomic profile, with the
  signed wording and citation; switching back to `synthetic` makes that evaluation read `knowledgeChanged`.
- The label: present on every screen that shows a `signed` result, and absent on synthetic ones.

## 6. Decisions for the founders

- **K2-D4, first:** clopidogrel (section 2). **Decided 2026-11-21 (founder): a.** Simvastatin alone in K1; clopidogrel after an indication
  spec.
- **K2-D1.** One knowledge set at a time, chosen by `ASSESSMENT_KNOWLEDGE`. **Decided: yes.**
- **K2-D2.** The narrow phenotype rule in 3.2, which changes spec 032's "never the laboratory's phenotype" for phenotype-only maps only.
  **Decided: yes.**
- **K2-D3.** The label's wording. **Decided: the English text in 3.4.** The Spanish text is still the founders' to write, before K2c.
- **K2-D5.** Who may see `signed` results on staging: everyone who can sign in there today, or only named usability participants.
  **Decided: everyone who can sign in**, since staging is invite-only and holds no real data.

## 7. Not touched

The lab-report pipeline and its production refusal, `LAB_REPORT_PIPELINE`, `EVALUATION_REQUESTS`, decisions and acknowledgements on staging
(direction plan F4), the medication and follow-up fences, real patient data and the AWS BAA, and the existing synthetic knowledge and its
tests.

## 8. How this was verified

Read on 2026-11-21: `apps/backend/src/config/env.ts` (the assessment's settings and refusals), `apps/backend/src/lab-reports/lab-reports.module.ts`
(both knowledge factories), `apps/backend/src/lab-reports/structured-assessment.ts` (what reaches the engine),
`packages/shared-types/src/synthetic-pgx.ts` (finding shapes, `laboratoryInterpretation`), `packages/cpic-schema/src` (no indication or
population field), `specs/032-pgx-report-service/coverage.md` (rows C01, C03, C06, C13) and `docs/design/plans/pgx-synthetic-assessment.md`.
**Not read:** CPIC's current clopidogrel and statin tables, which section 2 describes from spec 032's coverage notes; they are read when K1
is authored. Nothing was run.
