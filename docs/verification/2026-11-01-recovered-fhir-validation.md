# Recovered work and FHIR validation, 2026-11-01

The combined MD-a / fixture-lifecycle recovery was applied once to clean local checkout `916eb7561a5b253cc161de0bc9ebf44e19015e8c` on `recovery/md-a-fhir-local`. All 75 archive checksums verified and all 42 restored source files matched the attached archive. No commit, push, PR or deployment occurred.

## FHIR result

`pnpm --filter @telesphoros/smart-pilot build` and `test:ig` passed with Java 21, official Validator 7.0.1, FHIR R4 4.0.1 and Genomics Reporting 3.0.0. Both pinned primary artifact hashes matched the repository. Four positive controls had zero error/fatal issues; four deliberate defects were rejected for their intended reasons (missing category, wrong report code, wrong genotype value type, wrong extension value type). Each validator call took 36 seconds.

Positive warning counts were 11, 14, 14 and 8: 29 missing narratives, 9 missing performers and 9 missing effective times. These are the existing documented best-practice warnings, with no invented clinical facts. Remote terminology remained disabled using the existing `-tx n/a`; the finite exporter-code contract passed. No validator code, conformance expectations, checksum, TLS setting or timeout changed. This validates synthetic examples, not clinical use or a complete terminology service.

## Package access and cache

The primary `packages.fhir.org` server supplied R4 core with HTTP 200 (12,815,597 bytes) and all required versioned packages through the inherited session proxy with TLS verification. The secondary server redirected to `packages-cdn.fhir.org`, which the environment denied with 403; generic metadata endpoints returned 502. These limitations did not prevent the completed validation.

Java did not automatically use the session proxy. Real versioned packages were fetched with curl and extracted into the normal package-cache layout beneath `/workspace/recovery/java-home/.fhir/packages`. `JAVA_TOOL_OPTIONS` set only `-Duser.home=/workspace/recovery/java-home`. The validator used its existing cache fallback when latest-version metadata was unavailable; this run does not claim the cache contains the latest published dependencies.

Loaded packages: `hl7.fhir.r4.core#4.0.1`, `hl7.fhir.xver-extensions#0.1.0`, `hl7.terminology.r4#6.2.0`, `hl7.fhir.uv.extensions.r4#5.2.0`, `hl7.terminology#6.0.2`, `hl7.fhir.uv.extensions.r5#5.1.0`, `hl7.terminology.r5#6.2.0`, `hl7.fhir.uv.extensions#5.2.0`, and the IG dependencies `hl7.terminology.r4#6.1.0` and `hl7.fhir.uv.extensions.r4#5.1.0`. R5 core 5.0.0 was also cached for dependency resolution. Downloaded artifact hashes are recorded locally as observed hashes, not independent upstream pins.

Local evidence: `/workspace/recovery/fhir-results-success/summary.json`, positive/negative outcomes and logs, `/workspace/recovery/fhir-artifact-sha256.json`, and `/workspace/recovery/RESTORATION.md`. Rerun with `/workspace/recovery/rerun-fhir.sh` in an execution context with network permission. These absolute paths describe this workspace and are not portable published links. Earlier failed attempts remain in separate directories; only the successful summary establishes outcomes.

## Repository checks

All six required commands passed: typecheck, lint, test, build, test:infra (215 tests), and test:ci-config (217 tests). The final workspace test used the saved setup's `/usr/local/bin/docker-init -s -- pnpm test`: backend 156 suites / 2,076 tests passed; 24 suites / 446 tests skipped without service-tier configuration. SMART pilot passed 188 tests and shared types passed 137. Earlier runs encountered sandbox SWC cache ownership and the documented non-reaping PID 1 issue; logs remain, assertions were unchanged, and the final run passed outside UID remapping under the subreaper.

The recovered archive's PostgreSQL/S3 counts remain historical evidence, not current reruns. Browser, worker service, image rehearsal, real issuer, private reader and live-model profiles were not run. No new application feature was added beyond restoring the requested patches.
