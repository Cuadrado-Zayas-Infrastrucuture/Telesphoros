# Fix: the public repository's CI passes without the report-reader engine (local)

Date: 2026-10-23

The first CI run on the new public repository (published from a filtered history, without the reader engine) failed six jobs. Two causes were mine, both consequences of the engine-optional change and the history rewrite, and neither could show in the private repository's CI.

1. **`secret-scan`.** One finding: a migration-checksum row in `migration-history.spec.ts` that the `generic-api-key` rule reads as a key because the migration name contains "access". The repository already suppressed it in `.gitleaksignore`, but by a commit-hash fingerprint, and the rewrite changed every hash. `.gitleaks.toml` now allows exactly that row shape in exactly that file for exactly that rule, and `.gitleaksignore` is removed (its two fingerprints named commits that no longer exist).
2. **The three service tiers.** Tiers 2 and 3 passed every test (177 and 179 suites) and failed only on the guard step `! grep -F "[jest] NOT RUNNING"`, and the evidence gate (`service-evidence.mjs`) refuses any `NOT RUNNING` line too; both read my announcement of the skipped engine specs. The announcement is now `[jest] ENGINE ABSENT: skipping 21 specs ...`, a different marker, so `NOT RUNNING` keeps meaning "a service tier did not run its database or S3 specs" and no guard is weakened. A test pins that the evidence parser accepts the engine marker and still refuses `NOT RUNNING`; the reader-engine spec pins that the engine skip never uses `NOT RUNNING`.

Two more failures in the same run were not caused by this change and are left for their own pull requests: a 5-second timeout in `recommendation-integrity.pg-spec.ts` (tier 1) and one browser test whose sign-in callback reported "link expired or already used" (`foundation.spec.ts`, desktop). Both passed locally on the same tree.

Not changed: the guards, the evidence gate, the engine list, the default gitleaks rules.

Local until the founder says push.
