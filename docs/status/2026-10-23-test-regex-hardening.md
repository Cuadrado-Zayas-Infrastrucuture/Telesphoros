# Test regexes made linear or escaped (2026-10-23)

Date: 2026-10-23

**Implemented.** Five CodeQL alerts in test and CI files, none a vulnerability (triage in the vault, 2026-10-23: 20 open alerts, 0 real). `apps/backend/test/helpers/recovery-gateway.ts`: the credential pattern no longer lets a match run across a later `Credential=` (a credential value contains no `=`). Measured on the hostile input `Credential=!` repeated: the old pattern took 19 ms at the 16 KiB header cap and 17.3 s at 480 KB (quadratic); the new one 0.1 ms and 1.7 ms. Real credentials are read the same way. `.github/ci/guard.test.mjs`: the Dependabot ignore check reads the `ignore:` list line by line instead of with an overlapping repetition (8 ms on 200,000 lines; its three controls still fail when an entry is removed). `.github/ci/release.test.mjs`: the repository name is escaped before it becomes a pattern. `phenotype-engine.spec.ts`: the case-variant allele name replaces every `*`.

**Not established.** I could not reproduce the exponential backtracking CodeQL names for the Dependabot pattern (up to 22 repetitions ran in under a millisecond); the rewrite is linear regardless. Whether CodeQL closes these alerts is known only after its analysis of the pull request. No product code changed.
