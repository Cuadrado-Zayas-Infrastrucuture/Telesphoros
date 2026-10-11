# Authorized synthetic source-PDF verification

2026-10-11. Branch `feat/synthetic-source-pdf` from main `db96b1e`, after #70 merged. See [approved plan](../design/plans/synthetic-source-pdf.md) and [runbook](../ops/source-pdf-preview.md).

| Check | Result and limits |
| --- | --- |
| Pilot suite | 153 tests passed under Node 22.22.0. Includes actual loopback PDF transport, version/type/encoding/size/digest/signature/origin/redirect/expiry refusal, absolute deadline against an active slow stream, state changes during download and no fallback |
| Real PostgreSQL/API/S3 | Seven tests passed with signed fake-IDP tokens, actual Nest routes and restricted application roles. Configured PDF mode uses ten API GETs; evaluation/ledger counts remain unchanged. Returned bytes equal the D01 fixture and version equals the recorded upload |
| Storage version control | A new version uploaded over the original test key did not replace the selected PDF. Removing only the test's pinned version withheld the preview even with a newer version present. No shared or production object was removed |
| PostgreSQL / memory storage | Seven tests passed. Metadata mode still works; configuring PDF retrieval against a non-HTTP in-memory link is refused |
| FHIR | Existing pinned core R4 schema accepts the verified PDF DocumentReference, including base64 data, byte length and source-version/SHA-256 extensions. No IG conformance claim |
| Defect injection | Removing the response-version comparison caused the wrong-version refusal test to fail by returning bytes. Source restored; full pilot suite passed afterward |
| Browser | Built viewer tested in installed Chrome with a synthetic evidence response: downloaded bytes match D01, fixed synthetic filename, fragment cleared, link removed on expiry, no page errors. UI unit test also verifies blob revocation on chart change. This is not full OpenEMR-to-backend workflow acceptance |
| Types/lint/build | Workspace typecheck passed with workspace concurrency 1; pilot/backend lint passed; integration suite built the standalone pilot successfully |

## Separate build issue observed

The normal parallel workspace typecheck failed with `ENOENT` while both the backend and pilot pretypecheck hooks concurrently cleaned `packages/shared-types/dist/index.js`. Both hooks already existed on main. Serial verification ran the same checks successfully; this PR does not change scheduling, clean behavior or required CI. A separate build-concurrency fix remains a follow-up. Do not treat this local serial result as proof that the parallel race is resolved or that GitHub CI passed.

The initial browser attempt found no bundled Playwright executable; installed Chrome completed the same check. An initial sandboxed pilot run was interrupted after it stalled; the full loopback-enabled run passed. Neither incident is claimed to be a product failure or masked by a relaxed test deadline.

## Evidence and boundaries

Real local links (workstation-specific):

- [153 pilot tests](/private/tmp/source-pdf-tests-final.log)
- [PostgreSQL/API/S3](/private/tmp/source-pdf-real-final.log)
- [PostgreSQL/memory](/private/tmp/source-pdf-real-memory.log)
- [Version-guard defect injection](/private/tmp/source-pdf-mutation.log)
- [Serial workspace typecheck](/private/tmp/source-pdf-types-serial.log)
- [Parallel build race](/private/tmp/source-pdf-types-final.log)
- [Browser result](/private/tmp/source-pdf-browser.json), [screenshot](/private/tmp/source-pdf-browser.png), [local test script](/private/tmp/source-pdf-browser.cjs)

No backend route, schema, SQL, retention setting, clinical gate, infrastructure, EHR write or deployment changed. The existing authorized pinned-link endpoint is reused. Signed URLs/storage keys/tokens are not exported. Closing reads detect observed changes; they are not an atomic snapshot or live correction feed. A saved synthetic download cannot be revoked. PDF integrity does not establish content safety, clinical validity, production authorization or live AWS retention enforcement. GitHub CI remains required before merge; this document records local verification only.
