# Synthetic PGx contract prototype verification

Date: 2026-11-02

Base: main `4615b9a2`; branch `feat/pgx-synthetic-contracts`. Spec PR #259 remains separate. AI-assisted implementation and manual agent review; no human clinical validation claimed. No personal report bytes/identifiers, production content, runtime route or migration changes.

## Behavioral evidence

- Initial public-contract test run before implementation: 49 new tests failed because the schema/parser exports were absent; 137 existing tests passed (`/tmp/pgx-contract-red.log`).
- Resolved, uncertain and amended JSON fixtures were authored independently of the schema. Round-trip checks preserve the original call, lineage, lab interpretation and context separately. Negative cases cover identity/revision, coverage/uncertainty, joint targets, medication prerequisites, source binding, unknown fields, clinical flags, real gene names and bounded UTF-8 input.
- Artifact checks compare deterministic output to committed bytes, validate the external hash/length manifest, detect altered/missing/extra files, preserve original values and limitations, escape PDF operators, and refuse unrenderable text or excess pages.
- Actual `pdftotext -layout` extraction with available Poppler **25.03.0** succeeded for all six PDFs, with independent checks of report/revision/disposition phrases and synthetic labels. This is a PDF readability check, not the pipeline's required 26.03.0 extractor qualification. A rendered first page was inspected for readable text and margins; generated PNG stays local under `/tmp`.

## Results

Pinned Node 22.22.0 / pnpm 10.28.0. Final results:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed after giving the malformed-case test table an explicit tuple/callback type. An intermediate annotation edit also failed parsing; it was corrected before the final successful runs. |
| `pnpm lint` | Passed, including source formatting. |
| `pnpm test` | Passed for configured service-free suites; explicit missing tiers below. |
| `pnpm build` | Passed; the frontend asset hashes/sizes matched the previous documentation-only baseline build. |
| `pnpm test:infra` | 285 passed, 0 failed/skipped. Static infrastructure guards only. |
| `pnpm test:ci-config` | 217 passed, 0 failed/skipped. |
| Shared-types focused tests | 206 passed across 7 files, including 69 new contract/artifact tests. No new mocks. |
| Paired fixture `--check` | All 12 artifacts match; existing lab-report fixture generator still matches its 36 artifacts. |
| Whitespace / local links | Staged diff check passed; 11 local document links resolve. Scoped PDF binary attributes preserve significant xref bytes. |

Targeted mutation checks, restored before final tests: removing report binding caused 2 refusals to fail; removing uncertain-finding gating caused 2 to fail; removing held-result wording exclusion caused 5 to fail. All three mutation runs exited 1 for failed behavioral assertions, not setup failures. Logs: `/tmp/pgx-contract-mutation-*.log`. The final test run also includes explicit attempted promotion of ambiguous/no-call findings and a patient mismatch where the assessment/context agree with each other.

Workspace counts: root scripts 47; jobs 20; notifier 10; CPIC schema 48; fake IDP 7; shared types 206; AI service 347; worker 151; SMART pilot 188; frontend scripts 55 and Vitest 694; backend 2,077 passed in 156 suites. Backend additionally reports **471 skipped tests / 27 skipped suites**, including absent PostgreSQL/S3 configuration and five reader-engine-dependent specs. Worker PostgreSQL/S3 suites were also not run. No database/S3, browser, image, hosted or clinical acceptance is inferred from this local run.

Final command logs: `/tmp/pgx-contract-final-{typecheck,lint,test}.log`, `/tmp/pgx-contract-{build,test-infra,test-ci-config}.log`. Initial failures remain in the earlier logs; no check was weakened or skipped to obtain these final results.

## Limits

No clinical recommendation engine, genotype translation, FHIR conformance, source authentication or laboratory analytical validation is established. The three schema examples and structural tests do not complete all 19 acceptance scenarios in the proposed service specification. Existing PostgreSQL/S3, missing-reader-engine and browser/hosted tiers are separate evidence. No new UI or schema persistence is implemented, and no deployment or clinical activation occurred.
