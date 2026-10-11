# Stored synthetic PGx verification

2026-10-11; branch from main `3210f21` after #69 merged. Scope: isolated SMART reader/mapper, its shared DTO dependency, backend integration tests and documentation. See [plan](../design/plans/synthetic-stored-pgx.md) and [runbook](../ops/stored-pgx-preview.md).

| Check | Evidence |
| --- | --- |
| Pilot suite | 127 tests passed under Node 22.22.0: stored-principal/EHR binding, DTO/state/source checks, no fallback, changed records, late expiry, core R4 structure/reference closure, phenotype-only/multi-gene mapping, existing SMART and viewer/isolation controls |
| Real PostgreSQL/API/S3 | Six tests passed using existing ephemeral database helpers, signed fake-IDP access tokens, actual Nest routes and restricted application roles; real S3 protocol through Moto |
| Read-only control | Successful preview made exactly nine GETs; evaluation and ledger counts unchanged. Application role had `rolsuper=false`, `rolbypassrls=false` |
| Real refusal cases | Cross-tenant and cross-patient data, forged token, old selection after a newer evaluation, retracted current selection without fallback, rejected acceptance, active dispute and pipeline-off were withheld |
| Defect injection | Removing the configured-tenant check made “withholds wrong tenant” fail by returning a preview. Source restored and the full suite rerun green |
| Types/lint/build | Workspace typecheck/build and pilot/backend lint passed. Standalone pilot typecheck/test/build now build the shared DTO dependency first, matching the repository's existing package convention |
| Install / CI guard | Frozen lockfile install passed; 35 CI guard tests passed. An initial offline install lacked a cached package; the same frozen lockfile installed successfully afterward |
| Real OpenEMR browser regression | Both existing static synthetic chart launches passed on ports 8301/8767, including consent withholding and cleared fragments. Stored mode was verified through actual backend HTTP plus the pilot route's stored-reader tests; no full OpenEMR-to-stored-backend browser acceptance is claimed here |

The first unit run rejected a valid identity-provider root URL; the URL check was corrected without relaxing loopback/query restrictions. An existing simultaneous-launch test also timed out in that run; subsequent full runs passed without changing its deadline. No check, clinical gate or timeout was weakened.

The shared FHIR builder is used for both modes. Stored source references preserve the report/capture/digest metadata but do not pretend to expose an object-storage version, download URL or verified PDF bytes. Recommendation text is deliberately omitted. The public DTO contracts and existing authorized GET routes were reused; no production route, schema, SQL, clinical engine/knowledge, retention or infrastructure configuration changed.

Local evidence links (real paths; not portable):

- [Pilot tests](/private/tmp/stored-pgx-tests-final.log)
- [Real PostgreSQL/API/S3 tests](/private/tmp/stored-pgx-real-api-final.log)
- [Tenant-guard defect injection](/private/tmp/stored-pgx-mutation.log)
- [Workspace typecheck](/private/tmp/stored-pgx-types-final.log)
- [Browser verification JSON](<home>/Documents/Codex/2026-10-11/ch/work/telesphoros-remastered-smart-pilot/packages/smart-pilot/openemr/.runtime/browser-verification.json)

Runtime files and credentials remain ignored. The new PostgreSQL spec joins existing CI tiers automatically; merge still requires repository-wide CI. This record does not predeclare CI results. Multiple closing reads detect observed changes but do not provide an atomic database snapshot or continuous invalidation. Production consent/delegation, source retrieval, correction-history exchange and clinical/IG validation remain separate work.
