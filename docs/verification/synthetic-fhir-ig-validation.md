# Synthetic terminology and IG verification

Scope: the [approved plan](../design/plans/synthetic-fhir-ig-validation.md), based on main `0e745bb`. Only the local synthetic mapper and its validation tooling change. No production backend routes/schema, authorization scopes, clinical gates, retention settings or deployment resources change.

## Independent validation

The official HL7 Validator 7.0.1 checks the generated Bundle resources against FHIR R4 4.0.1, Genomics Reporting 3.0.0 and the local draft extension/CodeSystem definitions. Four controls cover static embedded source, multi-gene stored metadata, a synthetic PDF attachment and phenotype-only content. All have zero error/fatal issues. Four mutations are rejected for their intended reasons: missing required genotype categories, wrong report LOINC, wrong genotype value type, and wrong local extension value type.

Evidence: [summary](/private/tmp/ig-validation-final/summary.json), [positive outcomes](/private/tmp/ig-validation-final/positive-outcome.json), [negative outcomes](/private/tmp/ig-validation-final/negative-outcome.json), [positive log](/private/tmp/ig-validation-final/positive.log), [negative log](/private/tmp/ig-validation-final/negative.log), [runner result](/private/tmp/ig-runner-final.log).

Positive examples retain best-practice warnings for missing narrative, clinical performer and effective time. Informational messages identify open slices, uncoded genotype text and disabled remote terminology. None of those missing clinical facts is fabricated. Supplied phenotype text remains local and is not reclassified as a standard therapeutic implication. The PDF example tests Attachment representation, not parsing or clinical content of a report. The existing actual-backend/PDF checks cover retrieval independently.

## Regression checks

- 180 pilot tests across eight files passed, including profile-pattern and unknown code/system mutations, source integrity, correction history, stale-view clearing and read-only refusal controls: [test log](/private/tmp/ig-tests-complete.log).
- Eight actual authenticated backend tests passed against local PostgreSQL and the S3 emulator, including correction transitions and PDF/source refusals: [API log](/private/tmp/ig-real-api.log).
- Workspace typecheck, lint and build passed: [types](/private/tmp/ig-workspace-types.log), [lint](/private/tmp/ig-workspace-lint.log), [build](/private/tmp/ig-workspace-build.log). The final pilot build is recorded [here](/private/tmp/ig-build-final.log).
- All 35 CI-configuration guards passed: [guard log](/private/tmp/ig-ci-guards.log).

The fixed LOINC/category patterns come from hash-pinned published snapshots rather than the mapper. A finite emitted-code contract supplements the official validator, which runs with remote terminology disabled. The primary JAR/IG artifacts are checksum pinned; package dependencies are resolved through the validator's cache and recorded in its logs. See the [validation contract](../../packages/smart-pilot/test/fhir-ig/README.md) for exact sources, hashes and limits.

This is no-error validation of selected synthetic examples against two declared profiles, not complete terminology certification, complete implementation of the IG, clinical approval or full OpenEMR workflow acceptance. Full synthetic workflow acceptance remains the final planned slice.
