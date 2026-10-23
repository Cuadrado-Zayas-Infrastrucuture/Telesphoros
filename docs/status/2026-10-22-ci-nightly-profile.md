# CI: pull requests run two backend profiles; all three run nightly (local)

Date: 2026-10-22

Pull requests and pushes now run the memory and PostgreSQL + S3 backend profiles; the standalone PostgreSQL profile runs in a new nightly (`schedule`, 07:41 UTC, and `workflow_dispatch`) together with the rest of the workflow, so `main` is still proved in full on every day it changes. The expected profile set comes from one place (`.github/ci/service-profiles.mjs`) and is read by the joining gate's dependency check, its evidence collector, the final acceptance and both recovery validators. Only an explicit success of the `changes` job with `postgres == 'false'` narrows it to two; every other case (a failed, skipped or silent `changes`, the old three-key shape, the nightly) expects all three, and a producer that ran when it was not expected is refused as firmly as one that was skipped when it was. A nightly is skipped when an earlier one already passed everything at the same commit.

Verified locally: `pnpm test:ci-config` with the gate's dependency check, the six- and nine-record collection and final acceptance, and the nightly decision exercised on every refusal; on-disk mutations that each turned the guard red. Not verified: GitHub's scheduling and the concurrency-group behaviour for a nightly, and any real runtime saving, because hosted CI is stopped until the minutes reset. Dropping the standalone profile from pull requests is a coverage decision for the founder: see the PR text.

Local only: nothing is pushed.
