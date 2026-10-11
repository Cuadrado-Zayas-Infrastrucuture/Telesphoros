# Synthetic OpenEMR SMART pilot — verification

Date: 2026-10-11. Port base: Remastered `main` at `4194eaa`. Branch: `feat/openemr-synthetic-smart-pilot`.

## Current status

The original Telesphoros repository was deleted, as confirmed by the founder. Its cached base does not exist in Telesphoros-Remastered. The existing authenticated account has access to the replacement; this work is ported onto a fresh branch from its current main, rather than changing the old checkout's remote or joining unrelated histories. Draft PR review and required CI remain separate from local evidence below.

## Verification results

| Category | Check | Result |
|---|---|---|
| Real EHR integration | New isolated OpenEMR 8.4.1 chart → OAuth → FHIR → viewer, patient 1 | PASS: correct patient/practitioner, medication and labeled genomic fixture |
| Real EHR integration | Patient 2 | PASS: distinct patient and genomic content withheld without consent |
| Real EHR integration | Fragment cleared; clinical recommendations disabled | PASS for both chart launches |
| Pilot tests | HTTP refusal/control, UI and production-startup tests | 34 passed |
| Mutation control | Disable medication subject matching temporarily | Cross-patient test failed: HTTP 200 instead of 422; source restored and all 34 tests passed again |
| Provisioning control | Change first synthetic seed UUID temporarily, then restore | Real CLI refused identity drift; original seed reran successfully without remapping |
| Workspace tests | Node 22.22.0, matching CI | Backend: 75 suites / 1,151 tests passed; 7 suites / 182 tests skipped. Frontend: 184 passed. Shared types 22, CPIC schema 36, fake identity provider 7, Lambda 9 passed |
| Quality | Workspace typecheck, lint and build | PASS |
| CI configuration | Existing configuration guard | 34 passed; workflows unchanged |
| Image | Pinned OpenEMR compatibility image | Built and exercised by both real browser flows; UUID boundary probes retained in the build |

The first workspace run used the machine's newer Node and failed the existing Unicode guard (runtime 17.0, required 16.0). Rerunning with the repository's exact Node 22.22.0 resolved those failures. The guard was not modified. Local database/S3 test tiers were explicitly skipped because TEST_DATABASE_URL and TEST_S3_ENDPOINT were not set; this report does not claim they passed. Required CI runs those tiers.

The browser script initially attempted to reset its local cookie before selecting the target domain. After moving the reset behind the EHR navigation, both chart flows passed. Browser credentials, OAuth URLs and raw diagnostic payloads were withheld. Screenshots and aggregate JSON remain in the ignored local runtime directory, not committed.

## Upstream patches and connector handling

The isolated image retains the source-hash-checked user-UUID forwarding and binary patient-UUID lookup corrections. Existing denial behavior is preserved. The connector handles a missing JWT key ID only with a single eligible pinned RSA key, the non-resource nonce scope, absolute clinician references, and collection/searchset bundles. Signature, issuer, audience, expiry, nonce, read-only scopes, exact mappings and bounded patient-specific pagination remain enforced.

## Controls and limits

- Only synthetic data; consent/genomic states are engineering fixtures.
- The connector performs FHIR GETs and the OAuth token POST only. Provisioning is a separate CLI restricted to the named synthetic container.
- No production Nest API module, UI route, database migration, RLS, clinical engine, real knowledge, AWS configuration or clinical release control changed.
- Loopback HTTP and bounded in-memory sessions only. No durable production session/audit/consent integration is claimed.
- No real patient information, resolved credentials, screenshots or generated runtime registrations are part of the PR.

## Follow-ups

Review the draft and require all repository CI gates before merging. Production adoption requires separate TLS, session/audit/consent and organization-mapping work plus clinical validation and release approval. No merge or deployment is included here.

See the [runbook](../ops/openemr-smart-pilot.md) for setup, chart launch and teardown.
