# Applied status lives in one place, and CI refuses it elsewhere

Date: 2026-10-30

**Implemented.** `docs/ops/environments.md` is the only place that says what is applied in AWS. A test in
`.github/ci/guard.test.mjs` (`pnpm test:ci-config`) refuses "not applied", "never applied", "not yet applied", "never been
applied" and "nothing (here) is applied/deployed" in the files that have no dated history: every file in
`infrastructure/terraform/`, the app READMEs, `CLAUDE.md`, the pull-request template, `ci.yml`, the Spec Kit constitution and
the worker's deploy-contract test. On the main it was written against it found 24 lines; they now describe what each file
is, and leave where it runs to `environments.md`. The constitution restatement was corrected (1.0.1). Comments and prose only:
no Terraform resource changed.

**Not established.**
- The check is a word list: other wording for the same claim passes it.
- Dated records (`docs/status`, `docs/verification`, plans, specs, `CHANGELOG.md`, dated `docs/STATUS.md` sections) are not read, by design.
