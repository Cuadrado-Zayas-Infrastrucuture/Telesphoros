# Fix: the public repository's CI passes without the report-reader engine (local)

Date: 2026-10-23

The first CI run on the new public repository (published from a filtered history, without the reader engine) failed six jobs. Two causes were mine, both consequences of the engine-optional change and the history rewrite, and neither could show in the private repository's CI.

1. **`secret-scan`.** One finding: a migration-checksum row in `migration-history.spec.ts` that the `generic-api-key` rule reads as a key because the migration name contains "access". The repository already suppressed it in `.gitleaksignore`, but by a commit-hash fingerprint, and the rewrite changed every hash. `.gitleaks.toml` now allows exactly that row shape in exactly that file for exactly that rule, and `.gitleaksignore` is removed (its two fingerprints named commits that no longer exist).
2. **The three service tiers.** Tiers 2 and 3 passed every test (177 and 179 suites) and failed only on the guard step `! grep -F "[jest] NOT RUNNING"`, and the evidence gate (`service-evidence.mjs`) refuses any `NOT RUNNING` line too; both read my announcement of the skipped engine specs. The announcement is now `[jest] ENGINE ABSENT: skipping 21 specs ...`, a different marker, so `NOT RUNNING` keeps meaning "a service tier did not run its database or S3 specs" and no guard is weakened. A test pins that the evidence parser accepts the engine marker and still refuses `NOT RUNNING`; the reader-engine spec pins that the engine skip never uses `NOT RUNNING`.

The same run also failed the browser job and one tier-1 test for causes that are not about the engine or the history rewrite; they are fixed in the commits listed below.

Not changed: the guards, the evidence gate, the engine list, the default gitleaks rules.

Local until the founder says push.

Addendum, three more changes in the same pull request (the first run showed them; each has its own commit):

3. **Browser job.** Playwright was not told how many workers to use, so it used half the runner's cores: one worker on the old 2-core runners, two on the public 4-core runner. The tests share a few synthetic people and the API refuses a token issued in the same second as that person's sign-out, so a sign-out in one worker made a sign-in as the same person in the other fail ("Sign-in did not complete"). The failing tests differed from run to run, which is how this race behaves. `playwright.config.ts` now sets `workers: 1` with the reason beside it.
4. **Tier 1.** `recommendation-integrity.pg-spec.ts` builds a throwaway database and runs migrations up and down in each test, on the 5-second default timeout; the sibling heavy pg specs set 30 seconds. It timed out once on the cold runner and passed locally and in the second run. It now sets `jest.setTimeout(30_000)` too.
