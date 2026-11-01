# Medication source review

Date: 2026-11-01. Base: merged follow-ups, `54b982a`.

## Rights routing

The official [ECRI Contact Us page](https://home.ecri.org/pages/ecri-contact-us-form) lists `clientservices@ecri.org` and +1 610.825.6000 as its United States general contact. This provides a current route to request the authorized permissions contact; it does not identify an officer empowered to license ISMP content. The [terms of service](https://home.ecri.org/pages/ecri-terms-of-service) reserve copyright. No commercial/public-source/browser redistribution permission has been established, no message or form was sent, and no ISMP-only content was copied. The founder/counsel draft now includes this routing evidence.

## Source review

Release metadata retrieved from the [CPIC latest-release API](https://api.github.com/repos/cpicpgx/cpic-data/releases/latest) and [RxNav version API](https://rxnav.nlm.nih.gov/REST/version.json) matched the shipped baseline: CPIC v1.61.0 and RxNorm 05-Oct-2026. Metadata equality alone does not establish semantic equality of the ingredient snapshot.

The generator's exported `build()` ran against the live public APIs at 2026-11-01T20:25:44.368Z, with proxy, CA trust and release-stability checks intact. Its return value was saved outside the checkout rather than invoking the CLI artifact writer. All 297 entries and their source properties, canonical names, ingredient types, FDA display forms, releases, attribution and citations matched the shipped artifact after excluding only `version`, `accessedAt` and the same observation timestamp in the CPIC citation. No added or removed ingredients or other semantic changes were found. This is an ad hoc **CPIC/RxNav no-change review**, not merely a release-metadata check. The official [FDA Name Differentiation Project](https://www.fda.gov/drugs/medication-errors-related-cder-regulated-drug-products/fda-name-differentiation-project) page was independently opened on the same date. Its recommended-name table contains the same 43 unique case-sensitive Tall Man forms as the local FDA input, with no missing or additional forms (the source table repeats two forms). No FDA input update is needed. This remains an ad hoc source observation, not completion of the future scheduled review or human approval.

- Shipped version retained: `b67108bcce609d1ac7dd8df87f17128619abd3cfb478d582db159532a66acc0c`.
- Observation candidate version: `8567a0e9f42048bfe3ec9ab59f2a64f6e420a8af7a82c6cd63c53f24847de18c` (differs because observation time participates in the hash; not shipped).
- Operational owner: repository maintainer `jzayas03`; observation prepared by Codex for maintainer review in this PR. No independent human review is claimed.
- Compatibility decision: no artifact update or deployment is needed. The retired-ingredient compatibility blocker remains for any future pruning update; this no-change review does not resolve it.
- Next scheduled review remains 2026-11-10 at 09:00 America/Puerto_Rico. No reminder was created.

Session evidence is retained under `/workspace/recovery/maintenance-2026-11-01/`: release responses, candidate and comparison JSON. These local paths are not published evidence URLs. No raw patient data is involved. The shipped artifact is byte-for-byte unchanged.

## Local checks

Typecheck, lint, workspace tests, build and infrastructure guards (215 tests) passed. CI-configuration guards also passed (217 tests). The frontend suite passed 680 tests; shared types passed 137. The backend memory tier passed 2,076 with 446 skipped; five absent private-reader specs remain excluded. The tests ran under the supported subreaper and native filesystem context, with no weakened assertions or new mocks. Local Markdown link targets in all four changed documents exist, and `git diff --check` passed.

No application, generated artifact, dependency, schema or infrastructure configuration changes. No new tests were added for these documentation updates. Real PostgreSQL/S3, browser, FHIR and worker-service tiers were not rerun; the skipped tiers are not claimed as passes. No deployment or clinical activation occurred. The environment has no configured cloud identity, so this is not a new live staging observation. Local check logs are in the session evidence directory above.
