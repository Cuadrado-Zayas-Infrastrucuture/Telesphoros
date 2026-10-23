# Synthetic versioned PGx FHIR verification

Local verification: 2026-10-11. Base: main `935aebb`. Scope: isolated `packages/smart-pilot`, its test-only validator dependency and documentation. See [contract](../fhir-cds-hooks.md) and [plan](../design/plans/synthetic-pgx-fhir.md).

| Check | Result and limit |
| --- | --- |
| Pilot tests, pinned Node 22.22.0 | 80 passed: mapping/refusal controls, pinned R4 structural validation, HTTP OAuth/identity/expiry/read-only boundaries, viewer/session replacement and production isolation |
| Types / lint / build | Workspace typecheck and pilot types/lint/build passed; the browser build contains no server mapper/crypto or source-report ingestion service |
| CI configuration guard | 35 passed; no check/deadline changes |
| Frozen install | Passed with `CI=true pnpm install --frozen-lockfile --offline`; dependency diff is only the pilot devDependency on already-present Ajv 6.15.0 |
| Defect injection | Removing `selected.state !== "active"` made “withholds retraction” fail because it returned a Bundle; source restored, then all 80 tests passed again |
| Real synthetic OpenEMR 8.4.1 | Both chart launches passed on isolated ports 8301/8767. Patient 1 displayed evaluation 2 and DocumentReference in the expanded preview; patient 2's consent refusal withheld it. Fragments cleared; clinical recommendations disabled |
| Visual inspection | Expanded patient-1 preview inspected; JSON scrolls within the existing card, without write controls |

The initial structural test exposed that the official R4 schema permits missing primitive fields because primitives may be represented only by extensions. Tests now independently require the actual type/status/recorded values this preview emits. A deliberately removed status fails the combined validation. No schema constraints were weakened.

The fixture preserves v1 and v2 as distinct source/evaluation snapshots, but only the current explicit selection is emitted. Reordering input versions does not change output. Changing engine interpretation version changes interpretation IDs while preserving the source ID. Tests reject digest mismatch, conflicting source-version content, unknown selection, duplicate/current ambiguity, absent version metadata, wrong patient/tenant, held/retracted/superseded/stale/disputed/unconsented results, clinical approval claims and arbitrary source bytes. All references resolve to their expected resource types in the collection. Genotype/phenotype business identifiers are distinct; knowledge/acceptance metadata and source SHA-256 use documented local extensions rather than masquerading as report identifiers. The HTTP success control records only OAuth token exchange as a non-GET request.

Local evidence (synthetic only; real paths retained):

- Consented preview screenshot (`<task workspace>/telesphoros-remastered-smart-pilot/packages/smart-pilot/openemr/.runtime/patient-1.png`)
- Consent-withheld screenshot (`<task workspace>/telesphoros-remastered-smart-pilot/packages/smart-pilot/openemr/.runtime/patient-2.png`)
- Browser verification JSON (`<task workspace>/telesphoros-remastered-smart-pilot/packages/smart-pilot/openemr/.runtime/browser-verification.json`)
- [Final pilot test log](/private/tmp/pgx-pilot-tests-final.log)
- [Mutation failure log](/private/tmp/pgx-mutation.log)

These workstation links are not portable evidence artifacts; repository tests and the committed fixture/schema allow independent reproduction. Generated credentials and runtime artifacts remain ignored and uncommitted.

No PostgreSQL/S3 schema, production handler, retention rule or clinical gate changed. Repository-wide required CI is still needed before merge; this local record does not predeclare its outcome. No full FHIRPath/terminology/Genomics Reporting profile validation, production adapter, source-PDF retrieval, external publication, biological correctness, recommendation, clinical approval or production readiness is claimed.
