# Final synthetic OpenEMR workflow acceptance

Founder authorization: build from main, read-only and synthetic, preserve retention and clinical gates, open a draft PR. Base: `9c66493` (#76). This closes the planned synthetic integration sequence, not a production or clinical release.

## Scope

Connect the existing real OpenEMR chart launch and OAuth/PKCE exchange to the built SMART reader/viewer, actual Nest API with signed test identity, restricted PostgreSQL role and versioned S3 emulator. Reuse the existing reviewed D01 fixture pipeline and correction APIs; do not introduce an alternate mapper, evidence response stub or browser network mock.

The operator chooses the stored evaluation explicitly. A new selected replacement needs a fresh chart launch. A second synthetic chart has no genomic consent. Fixture setup and reviewer corrections write only to the newly generated test database/emulator bucket; connector reads must not change evaluation or ledger counts.

## Acceptance

| Scenario | Required observation |
| --- | --- |
| Chart launch | EHR patient/clinician binding, read-only medication context, consumed fragment, clinical recommendations disabled |
| Active stored evaluation | Four Observations, valid core R4 Bundle, correct evaluation and pinned PDF version, exact D01 bytes through the browser blob |
| Offline then online | Old evidence disappears and blob is revoked; fresh real reads recover it |
| Retraction | Real periodic recheck shows verified history, removes FHIR/profile/PDF, revokes prior blob |
| Independent reinstatement | Existing reviewer API restores eligibility; explicit recheck succeeds |
| Supersession | Old selection remains withheld; replacement is not disclosed/substituted automatically |
| Explicit replacement | Operator changes test registration in memory, then launches from the chart again |
| Source overwrite | Viewer still receives original pinned D01 bytes, never newer D02 |
| Missing pinned source | No fallback, history or PDF; sanitized unavailable state |
| Unconsented chart | Fresh second chart launch, no stored API reads or genomic/PDF/history content |
| Read-only | Connector EHR/API/PDF methods GET; OAuth token exchange separately counted; unchanged stored evaluation/ledger counts |

## Boundaries

No production route, schema, UI behavior, retention, clinical gate, deployment or EHR clinical write changes. No new clinical knowledge. The imported test-only text runner, fake backend identity provider and Moto remain test dependencies; this is not Poppler generalization, Cognito/AWS acceptance, complete IG certification or pharmacist sign-off. Existing CI checks stay intact. The real OpenEMR test is an explicit local acceptance command; CI continues the existing automated unit/API/browser/IG layers and runs its new preflight refusal tests.

## Verification

Run the real workflow to completion, pilot tests, backend typecheck/lint and existing stored-reader API tests with PostgreSQL plus S3. Inject a missing blob revocation into generated viewer output and require the workflow to fail, then rebuild and rerun cleanly. Preserve a sanitized aggregate local result, document remaining limitations, secret-scan the staged diff, and open a draft PR.
