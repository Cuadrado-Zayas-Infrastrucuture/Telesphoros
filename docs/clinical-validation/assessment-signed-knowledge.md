# Signed knowledge in the synthetic assessment, and the laboratory phenotype rule (spec 044, slice K2a)

Slice K2a lets the synthetic assessment read a signed, real knowledge set instead of the synthetic one, and lets a phenotype-only gene map
take the laboratory's reported phenotype as the engine's input. It adds no knowledge content: until slice K signs the first real files, the
only signed sets are test copies signed with keys made for one test run. Patients, laboratories and reports stay synthetic in every case, and
every evaluation stays `clinicalUse: "not-approved"`.

## What it decides

- **One set at a time** (K2-D1). `ASSESSMENT_KNOWLEDGE=signed` replaces the synthetic set; the two are never loaded together, so an invented
  drug and a real one never meet in one evaluation. The signed set is loaded under the production rules whatever `NODE_ENV` says, so an
  unreviewed, synthetic, edited or under-signed file stops the start.
- **The two kinds are told apart where they are stored.** An evaluation against the signed set has the scope
  `synthetic-patient-signed-knowledge`; against the synthetic set, `synthetic-structured-assessment`, as before.
- **The laboratory's phenotype, narrowly** (K2-D2). It is the input only for a gene whose loaded map is phenotype-only, only for a finding a
  second person accepted and that is tested, resolved and interpretable, and only when it is exactly one of the map's terms. No translation,
  case folding, trimming or near match is applied; anything else holds the revision as `unsupported-source` with the detail
  `phenotype-not-in-map`. The binding records the finding and the laboratory's translation version.
- **Everywhere a map can read a diplotype, nothing changes:** the diplotype is the input and the laboratory's phenotype is ignored, as spec
  032 decided. A gene with no map is handled as before.

## What it does not decide

Which real content is signed (slice K), how the screens label a signed result (slice K2c), and whether staging switches to the signed set
(slice K2d, a founder's apply). A laboratory's phenotype term is accepted only as the map spells it; mapping a laboratory's own vocabulary to
CPIC's terms is not done, and a laboratory that uses other words holds.

## Evidence (all on invented content and test-only keys)

- `apps/backend/src/config/env.spec.ts`: each refusal of the new settings, with its control.
- `apps/backend/src/lab-reports/lab-reports.module.spec.ts`: a copy signed by both test signers loads; one signer only, a trust list missing
  a signer, the synthetic set itself and an empty directory are each refused.
- `apps/backend/src/lab-reports/structured-assessment.spec.ts`: the rule's cases on the S1 fixture (exact term used, case and near matches
  held, no phenotype held, a map with alleles or a method and a gene with no map keep the diplotype, unreviewed and uncertain findings still
  hold first), and one case through the engine on a phenotype-only copy of the synthetic set.
- `apps/backend/test/signed-assessment-knowledge.e2e-spec.ts`: over PostgreSQL and S3, an assessment against a signed copy with GENEA made
  phenotype-only stores the signed scope, the expected cell's wording and the laboratory phenotype in the binding, and the ledger verifies; a
  phenotype not in the map holds.

**Not yet shown:** that each rule's test turns red when the rule is removed. The code was written where no code may run (founder decision
P2), so the defect injections are still to do before merge.
