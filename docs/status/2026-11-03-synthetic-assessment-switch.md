# The synthetic assessment switch (032 S3, PR 3a)

Date: 2026-11-03

`SYNTHETIC_ASSESSMENT` lets an environment that holds only synthetic data review, assess and read assessments of stored structured laboratory revisions, without the lab-report pipeline. It is off by default and nothing sets it yet: no Terraform variable, no frontend, so staging looks the same after this merges. It is a declaration by the environment's infrastructure that no real data is held; the application cannot verify it, and 3c has to make a Terraform guard fail if a production definition ever sets it.

What it needs: PostgreSQL, versioned S3, a watched ledger, a build version and its own `SYNTHETIC_KNOWLEDGE_DIR`; configuration refuses it beside `LAB_REPORT_PIPELINE`, in a disposable local run, or with a knowledge directory while it is off. The synthetic knowledge loads under the non-production rules, so the module itself refuses a directory holding anything that does not say it is synthetic, and an empty one.

What it opens, and nothing else: the structured preview routes (without the local-only gate), a new `POST /reports/:id/structured-assessment`, and `GET /evaluations` and `GET /evaluations/:id`. Each controller carries its own mark and a test lists them, so the switch cannot open a route without that mark being added on purpose. Decisions, acknowledgements, renders, disputes, corrections, captures, evaluation requests and the ledger routes still answer 503 PIPELINE_DISABLED with the switch on (tested over HTTP). Under the switch the data origin is `synthetic` (`structuredAssessmentOrigin`; the PDF path's `currentDataOrigin` is unchanged).

Also: the stored evidence an assessment was planned on (every stored revision of the patient, the newest review of each finding, every source resolution) is read again after the ledger lock; if any differs the assessment is planned again, up to three times, and then refused with nothing stored. That closes the gap recorded after PR 2b. `data/fixtures/pgx-structured-demo/package.json` is a demonstration package whose alleles the knowledge maps define; it is assessed byte for byte over HTTP in a test.

Verification, on PostgreSQL 16.15 with scram passwords, Moto 5.2.4, Node 22.22.0, pnpm 10.28.0:

- `synthetic-assessment.e2e-spec.ts`: 12 passed (the app started as the synthetic staging runs: switch on, no pipeline, no local run). `structured-assessment.spec.ts`: 25 passed. With the neighbouring configuration, ledger, lab-report, structured and gate suites: 549 passed in 30 suites, on the final tree.
- 18 guard-removal controls (each gate, mark, recheck, origin and configuration rule) each turned a suite red; three survived the first pass because production mode already implied them or no test raced a resolution, and tests were added.
- Backend tiers 1, 2 and 3: 3428, 4077 and 4183 passed (757, 108 and 2 skipped). Each also reported 38 failures: the three recovery suites (37), which start their own PostgreSQL and were run sandboxed, and one controller-inventory test that needed the new controller added (fixed afterwards, 77 of 77). The three recovery suites passed 37 of 37 run alone outside the sandbox.
- `typecheck`, `lint`, `format:check`, `build`, `check:chunks`, `knowledge:verify --production`, `check:workflows`: passed. `test:infra` 300, `test:ci-config` 221, root `pnpm test` 47 (backend in-process 2133), `test:demo-seed` 8 (with the database settings): passed.

Not run: the published FHIR IG validation (needs Java 21 and network), the browser and image tiers, hosted CI. Not built: any page, the Terraform variable, the release of migrations 0068 to 0070, medication and indication context, decisions and acknowledgements of an assessment. Machine note: each sandboxed run of the recovery suites left one SysV shared-memory segment behind (4 in use before the tiers, 13 after, of 32); when they reach 32 `initdb` fails again.

Next: 3b (the staging frontend) and 3c (Terraform variable and guard, release of 0068 to 0070 and the image, the acceptance run), each its own PR with its own plan.
