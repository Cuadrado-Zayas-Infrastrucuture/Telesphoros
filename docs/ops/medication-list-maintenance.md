# Medication list maintenance

Date: 2026-11-01. Scope: the capture-only ingredient list introduced in spec 029; this is not a clinical guideline update procedure.

## Owner and cadence

The repository maintainer, currently `jzayas03`, owns each review, source retrieval and proposed update. A maintainer reviews the generated diff before merging it. A pharmacist or clinical content reviewer must review any future change that claims clinical meaning; this operational assignment does not appoint a clinical signer.

Review on the **second Tuesday of each month at 09:00 America/Puerto_Rico**, starting **2026-11-10**. Also review when CPIC announces a new data release or FDA changes its published Tall Man list. This is the maintenance policy; an automated reminder is tracked separately and is not implied to exist merely because this document exists. A review more than 45 days after the previous review is overdue and is raised to the maintainer. An overdue review does not silently rewrite records or disable medication capture.

## What the owner checks

1. Read the current artifact's CPIC associated release, RxNorm release, retrieval timestamp, source properties and content version. Read [the generator contract](../../scripts/drug-list/README.md) and the [licensing limits](../../specs/029-patient-medications/spec.md#open-questions).
2. Retrieve CPIC release/API and RxNav data through the existing generator with proxy/TLS and integrity checks intact. Use a fresh feature branch; run `node scripts/drug-list/build.mjs` from the repository root. No patient input or runtime search is involved. Do not edit generated rows, substitute a failed request, fabricate a code, or reinterpret an API snapshot as a pinned database export.
3. Compare semantic changes separately from retrieval timestamps: added/removed RxCUIs, canonical name and IN/MIN type changes, source-property evidence, releases, Tall Man display and citations. If nothing changed except observation time, record a no-change review and leave the shipped snapshot unchanged; do not manually repair generated content to suppress a difference.
4. Keep FDA-only display until the [ECRI/ISMP permission track](../design/plans/medication-followups.md#permission-request) has written approval. Check the NLM attribution and currency notice in both the artifact and the patient-page information disclosure.
5. Run generator controls, shared-type tests, and medication API/real PostgreSQL checks. Run the six repository checks and the applicable browser/branding checks for changed surfaces. Confirm canonical names remain stored and Tall Man remains presentation-only.
6. Review compatibility before merge. The API rejects a stale list version with `drug-list-changed`; frontend and backend must ship the same artifact. Historical entries retain their original list version and canonical name. Before accepting removals, verify the [historical same-code correction/stop path](../verification/historical-medications.md) against the proposed artifact: it retains the prior canonical name and source-list version while requiring acknowledgement of the current catalog. New entries still need a currently listed ingredient. **Block pruning updates until this compatibility change is reviewed and its tests pass with the proposed refresh**. Do not silently replace historical codes or delete a medication to make a refresh pass.
7. Open a PR with the review record below and source diff. Keep release/deployment separate; no automation may merge, publish, rewrite medication history or lift a clinical hold.

Suggested focused commands, in addition to the required repository checks:

```sh
node --test scripts/drug-list/build.test.mjs
pnpm --filter @telesphoros/shared-types test
pnpm --filter @telesphoros/backend exec jest --runInBand --runTestsByPath test/patient-medications.e2e-spec.ts test/db/patient-medications.pg-spec.ts
```

The last command needs the documented disposable PostgreSQL configuration (`TEST_DATABASE_URL`, `TEST_STORAGE=postgres`) and supported local native-binding/subreaper setup. A skipped database tier is not a pass. Use the existing storage-e2e browser harness when UI behavior changes.

## Review record

Record date, operational owner, previous/new CPIC and RxNorm releases, old/new content versions, semantic differences or no-change result, source/license observations, compatibility decision, test counts/skips, reviewer, PR and release reference. Record failures and unresolved rights explicitly. Never include patient data, access tokens or a private licensing screenshot. Written licensing correspondence stays in founder/counsel-controlled storage; record only its reference and approved scope in the public repository.

The initial shipped artifact was retrieved on 2026-11-01: 297 ingredients, CPIC associated release v1.61.0, RxNorm 05-Oct-2026. This is the baseline already verified in [the recovery record](../verification/patient-medications.md), not a claim that a new source refresh ran for this maintenance policy.

An ad hoc [2026-11-01 source review](../verification/medication-source-review.md) reran the generator against the public APIs: all 297 ingredients and source evidence were semantically unchanged, so the shipped artifact was retained. This does not replace the next scheduled monthly review or resolve the retired-ingredient compatibility requirement.
