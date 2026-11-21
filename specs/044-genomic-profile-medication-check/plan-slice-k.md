# Plan: spec 044, slice K, the first signed CPIC content (M2.4, first set)

**Status**: **draft; K-D1, K-D2 and K-D3 decided by the founder on 2026-11-21 (section 6), the rest open.** Plan only: no knowledge file, code, Terraform or clinical hold changes. Read against
`main` at `ef7f8eb` on 2026-11-21. Slice K of [spec 044](spec.md); roadmap row M2.4 of the
[repository audit and build plan](../../docs/design/plans/repo-audit-and-build-plan.md).

## 1. Why

The genomic profile (slice A) answers "No guideline loaded" for every real medication, because `knowledge/cpic/` is empty. Real guidance
needs real content, reviewed and signed by two pharmacists. Both co-founders are pharmacists (spec 044 GP-N3), and the other co-founder
holds the second signing key (G1).

## 2. What exists (read 2026-11-21)

| Piece | State |
| --- | --- |
| Format | Schema 1.3 gene maps and guidelines, with RxCUI, HGNC id, origin, licence and redistribution ([cpic-integration.md](../../docs/cpic-integration.md)) |
| Review | `knowledge:hash`, then `review: {status: reviewed, reviewedBy, reviewedAt, contentSha256}`; each cell `verification: verified` with `verifiedBy` and `verifiedAt` |
| Signing | `knowledge:sign` with each signer's own KMS key; production loads a file only with valid signatures from **two distinct signers** (audit CLIN-01) |
| Keys | `infrastructure/terraform/knowledge-signing.tf` and [the signing runbook](../../docs/ops/knowledge-signing.md): one key per signer, nothing created until `knowledge_signers` names two principals. **Not applied.** The founder runs the apply; an agent only prepares it |
| Loader | Production rules refuse synthetic, unreviewed, schema 1.2, `unknown` licence, redistribution or origin, and bad signatures; a CI test loads `knowledge/cpic/` under those rules |
| Licence | CPIC confirmed in writing (2026-08-31, founder-held) that content of the `pair`, `recommendation`, `guideline`, `drug`, `publication` and `test_alert` endpoints is CC0 1.0 (data-products plan, R13-CPIC). **Allele definitions and diplotype tables are not in that list**, and PharmVar's own terms are unread (R13-PharmVar) |
| Authoring | The private repository's curation registry "requires both ids on every drug and gene record and compiles them into 1.3 files" (spec 039). Not readable from this repository |

## 3. The finding that shapes this slice

**Nothing on staging would read real content today.** Real knowledge loads only for the lab-report pipeline (`labKnowledgeFactory`,
`KNOWLEDGE_DIR`), which `NODE_ENV=production` refuses. Staging's only evaluation path is the synthetic assessment, whose knowledge must be
synthetic file by file (`syntheticKnowledgeFactory`: "must hold synthetic knowledge only"). So a signed real set, committed today, would be
checked by CI and used by nothing.

The slice is therefore two parts:

- **K1, the content:** the first pairs, authored, reviewed, signed and committed, proved by the production-rules loader test and by
  `knowledge:verify --production` with the real signer keys. Nothing a user sees changes.
- **K2, a path that reads it:** a separate plan and decision (K-D1 below). Until it lands, the profile still says "No guideline loaded".

## 4. K1 in detail

### 4.1 The first pairs (G2, for the founders to choose)

**Decided 2026-11-21 (founder): the first set is simvastatin (SLCO1B1) alone.** Clopidogrel was chosen first, then deferred the same day
(K2-D4 in [the K2 plan](plan-slice-k2.md)): its recommendations differ by indication, which the knowledge format cannot express yet.
Sertraline follows in a later set; DPYD and CYP2D6 after a format decision. Proposed, smallest first, all with published CPIC guidelines; each guideline's current version, tables and wording are read from CPIC at
authoring time, not from this plan:

| Drug | Gene(s) | Why first | Format note |
| --- | --- | --- | --- |
| clopidogrel | CYP2C19 | The most cited PGx interaction; one gene; phenotype-keyed table | Fits schema 1.3 as it is |
| simvastatin | SLCO1B1 | Common in primary care; one gene | Fits; the statin guideline covers other statins and genes, left out of this set |
| sertraline | CYP2C19, and CYP2B6 if the current guideline keys sertraline on both | Already on the founder's waiting list | A two-gene combined table if so; the engine supports up to four genes |
| fluorouracil, capecitabine | DPYD | Severe toxicity risk | **Later:** DPYD recommendations are keyed on an activity score, which a phenotype-only map does not express without a format decision (K-D3) |

CYP2D6-keyed drugs belong with DPYD for the same reason.

### 4.2 Phenotype-only gene maps first (K-D3)

A gene map may list only the gene and its phenotype terms, with no alleles and no method; the input is then the phenotype the laboratory
reported (`cpic-integration.md`, gene map). This keeps K1 inside the CC0 endpoints: phenotype terms appear in CPIC's `recommendation`
lookup keys. Allele definitions, function assignments and diplotype tables come from other CPIC tables and from PharmVar, whose terms are not
settled. The cost: a report that gives only a diplotype holds as `no-phenotype-mapping` until diplotype maps are licensed and added.

### 4.3 How a file is made, reviewed and signed

1. **Author** in the private curation registry, which compiles schema 1.3 files (spec 039), with `provenance` naming CPIC, the source URL,
   the retrieval date, `sourceVersion`, `license: cc0-1.0` and `redistribution: allowed`, and `origin: cpic` on every cell and map.
2. **First pharmacist (the founder) reviews** every cell against the guideline's printed table: `when`, `locator`, `strength`,
   `recommendationText` copied verbatim, `implication`. Each checked cell becomes `verified` with `verifiedBy` and `verifiedAt`. A cell that
   cannot be checked stays `unverified` and is never shown.
3. **Hash and mark reviewed** (`knowledge:hash`, then the `review` block).
4. **Second pharmacist (the co-founder) reviews independently**, the same way, before signing. A signature means "I checked this file", so
   the second signature is the second review, not a formality.
5. **Both sign** with their own KMS keys (`knowledge:sign`); each adds the printed entry to `review.signatures`.
6. **Verify** with `knowledge:verify --production` and the real `KNOWLEDGE_SIGNER_KEYS`; commit to `knowledge/cpic/`; CI loads the folder
   under the production rules.

### 4.4 Keys, before any signing

The founder applies `knowledge-signing.tf` with two entries in `knowledge_signers`, one IAM principal per pharmacist, following the runbook.
The co-founder needs an IAM role or user of their own in the account, which [team-access](../../docs/ops/team-access.md) does not yet
describe. Cost about $2 a month.

### 4.5 Tests and evidence

- The existing production-rules loader test over `knowledge/cpic/` (no new test needed to refuse bad content).
- A hand-written expectation per pair, written by a pharmacist from the printed table before any evaluation runs: for each phenotype
  combination, the outcome and strength expected. An engine test evaluates the signed set against those expectations (working agreement 6:
  hand-written results are the oracle).
- A clinical-validation note in `docs/clinical-validation/` naming each file, guideline version, reviewer and signer, and what was not
  checked.
- Defect injection: one edited cell must make the loader refuse the file (hash), one signature removed must make production refuse it, one
  expectation changed must make the engine test fail.

## 5. K2 options (decision K-D1)

| Option | What it means | For | Against |
| --- | --- | --- | --- |
| **a. Real guidance, synthetic patients, on synthetic staging** | The synthetic assessment may evaluate against the signed real set, under a new, separate switch; synthetic structured reports carry real gene names and phenotype terms | The profile shows real guidance for fictional patients: the first useful demonstration, and the first usability test that means anything | Reverses spec 032's "synthetic knowledge only" for this path; needs new synthetic fixtures, a kill switch and labelling; staging shows real clinical wording |
| b. Wait for the pipeline in production | Real content is read only when the report reader and the pipeline are released | No change to the synthetic path | The reader engine is not in this repository; far off |
| c. Local only | Real content is evaluated only in a disposable local run | Nothing on staging changes | No hosted demonstration; usability sessions need a local setup |

**Recommendation: a,** as its own plan after K1. Real CPIC wording shown about invented patients, labelled `not-approved`, is still a
synthetic demonstration; it is not clinical use and admits no real patient data, which still waits on the AWS BAA and every release gate.

## 6. Decisions for the founders

- **K-D1.** The path that reads real content (section 5). **Decided 2026-11-21 (founder): a**, real guidance for synthetic patients on
  synthetic staging, under its own switch, in its own plan after K1.
- **K-D2 (G2).** The first pairs (section 4.1). **Decided 2026-11-21 (founder): simvastatin (SLCO1B1) alone**, after first choosing clopidogrel and simvastatin; clopidogrel waits for
  an indication spec (K2-D4).
- **K-D3.** Phenotype-only gene maps first (section 4.2). **Decided 2026-11-21 (founder): yes.**
- **K-D4.** Authoring in the private curation registry, then committing the compiled, signed files here. Recommendation: yes, as spec 039
  describes. **I cannot see that repository**, so its steps are the founders' to confirm.
- **K-D5.** The co-founder's AWS principal for signing, and who applies the key Terraform. Recommendation: the founder applies; the co-founder
  gets a role that can only `kms:Sign` with their own key.
- **K-D6.** Before authoring, read the "March 2026 CPIC/ClinPGx field changes" the roadmap names for M2.4. Nothing in this repository
  describes them.
- **K-D7.** Product wording: CPIC's licence restricts the CPIC logo and acronym on other websites and in advertising without NIH
  permission (R13-CPIC). The question of describing the product as "CPIC-guided" is already open with the publishers.

## 7. Not touched

Code, migrations, the engine, the loader, the synthetic assessment, `syntheticKnowledgeFactory`, Terraform (until K-D5), the clinical hold,
`clinicalUse` and every release gate. K1 adds knowledge files and tests only; K2 is its own plan.

## 8. How this was verified

Read on 2026-11-21: `docs/cpic-integration.md`, `knowledge/cpic/README.md`, `docs/ops/knowledge-signing.md`,
`infrastructure/terraform/knowledge-signing.tf` (variables), `apps/backend/src/lab-reports/lab-reports.module.ts` (both knowledge
factories), `docs/design/plans/pgx-data-model-and-data-products.md` (R13-CPIC, R13-PharmVar, R14),
`docs/clinical-validation/identifier-keys.md`, `specs/039-identifier-keys/spec.md`, the M2.4 roadmap row, and
`docs/design/plans/pgx-synthetic-assessment.md`. **Not read:** the private repository and its curation registry, CPIC's current guideline
versions and tables, the March 2026 field changes, and PharmVar's terms. Nothing was run.
