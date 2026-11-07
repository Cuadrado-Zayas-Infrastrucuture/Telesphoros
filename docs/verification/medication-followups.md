# Medication follow-up verification

Date: 2026-11-01. Base: merged MD-b, `783b7c4`.

The follow-up documents define an operational owner and monthly cadence, an unsent rights request, a synthetic staging plan and a draft clinical specification. They do not establish a new clinical signer, legal permission, live infrastructure observation, release authorization, source-data refresh or scheduled automation.

## Attribution defect

Spec 029's plan requires the product page that shows the drug list to show its NLM attribution. The merged page did not render it. The new focused test was run against the exact merged MedicationsSection source: it failed because the attribution element was absent (`followup-attribution-red.log`). Restoring the new compact disclosure made it pass (`followup-attribution-green.log`). The test independently checks the NLM courtesy/non-endorsement text, currency notice, initial collapsed state and expanded visibility. No valid assertion was removed or weakened.

The real storage-e2e browser flow passed on mobile and desktop, with the attribution expanded and axe checked, followed by the existing coded capture/correction/stop/history/permission flows and both-theme accessibility checks. It used actual migrated PostgreSQL with a non-owner login, Moto, the fake RS256 issuer and the built application; no API behavior was mocked. The synthetic database/login were removed and the owned test cluster stopped after verification.

## Checks

- All six repository commands passed: typecheck, lint, test, build, infrastructure (215), CI configuration (217).
- Frontend: 680 tests passed; focused medication UI file: 12 passed. Branding/preview script controls passed as part of the frontend command.
- Backend workspace memory tier: 2,076 passed / 446 skipped; five absent private-reader specs remain excluded. Database service skips are not passes. Complete backend PostgreSQL/S3, worker-service, FHIR, image and unrelated browser profiles were not rerun for this follow-up.
- Workflow pack: five tests passed. New local document link targets exist. The first proposed maintenance review, 2026-11-10, was checked to be a Tuesday.
- The 297-entry artifact was inspected only for its existing metadata (CPIC v1.61.0, RxNorm 05-Oct-2026, retrieved 2026-11-01). No source refresh or generated-row changes occurred.

Local logs: `/workspace/recovery/followup-*`. These are session paths, not published evidence URLs. The permission recipient has not been verified, the draft has not been sent, no ISMP-only content was copied, and no AWS/model/clinical activation occurred. Any later hosted results belong in the follow-up PR; local software checks do not approve the clinical draft or deployment plan.
