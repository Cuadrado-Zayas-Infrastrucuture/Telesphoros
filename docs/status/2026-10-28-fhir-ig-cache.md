# CI: the FHIR Genomics IG validation caches its downloads (local)

Date: 2026-10-28

**The problem.** In the `verify` job, `pnpm --filter @telesphoros/smart-pilot test:ig` downloaded the pinned validator JAR, the Genomics
Reporting IG and every package the validator resolves on every run. Measured twice on a Mac with Java 21: 165 and 192 s cold, 23 and 21 s
warm. In the cold run, the first validator call took 83 s (it fetches the packages itself) and the second 11 s; warm, 10 s each. On CI the step took 315-427 s on passing runs. On PR #128 (2026-10-28), the first validator call stalled for its
full 360 s `spawnSync` limit and failed the job, on a branch that changed no FHIR code. The script wrote the validator's output only to a
temp directory that CI discards, so the log could not show what stalled.

**The fix.**
- `ci.yml` (`verify`): an `actions/cache` step (the pin the browser job already uses) restores `~/.fhir/packages` and
  `~/.cache/telesphoros-fhir-ig` before the IG step. The key is runner OS and architecture plus `hashFiles` of `validate.mjs`, which pins both
  artifacts' sha256. It never follows the commit or the workflow file.
- `validate.mjs`: a new `FHIR_ARTIFACT_DIR` chooses where the pinned JAR and IG are kept (default unchanged: the temp directory). The
  checksum is still verified on every load, so a bad cache entry is refused. Each validator call prints its duration; a failed call prints
  the last 40 lines of the validator's log.
- `.github/ci/cache.test.mjs`: the key, the two cached paths, and the cache step coming before the IG step are guarded; each has a control.
  All three rules report `main`'s workflow before this change.
- `.github/ci/scope.test.mjs`: the cache step joins the reviewed list of `verify` steps a documentation-only run skips, like the IG step.

**Checked locally.** Cold then warm with `FHIR_ARTIFACT_DIR`; one changed byte in the cached IG is refused by its checksum; a validator
that exits 3 after 50 lines fails the run and prints lines 11-50.

**Trade-off.** The validator-resolved packages (for example `hl7.terminology.r4`) are not pinned by checksum, and the cache keeps the versions
first fetched until `validate.mjs` changes. A cold run could resolve a newer one. This makes CI repeatable, not newer.

**Not changed.** The 360 s limit, validator 7.0.1, IG 3.0.0, the fixtures and expectations, and every other job.
