# Synthetic PGx contract examples

These are original invented records using GENEA–GENED and synthetic drugs/identifiers. They contain no vendor report or patient data. Their rules have no clinical meaning. Version `pgx-synthetic-0.1` is a deliberately bounded engineering contract, not a laboratory interchange standard or a clinically approved format.

| Example | Laboratory document | Derived assessment | Behavior illustrated |
| --- | --- | --- | --- |
| Resolved | [PDF](resolved/laboratory-report.pdf) | [PDF](resolved/assessment.pdf) | Complete invented inputs, original call retained separately from assessment source/context. |
| Uncertain | [PDF](uncertain/laboratory-report.pdf) | [PDF](uncertain/assessment.pdf) | Explicit ambiguous call/candidates and missing prerequisite; no recommendation wording. |
| Amended | [PDF](amended/laboratory-report.pdf) | [PDF](amended/assessment.pdf) | Revision 2 links to the resolved report; old interpretation remains in revision 1; new assessment is held pending review. |

Each directory contains `package.json`, two selectable-text PDFs, and `artifacts.json` with SHA-256 and byte length for all three source/output files. The manifest is outside the package, avoiding a circular hash. It checks exact bytes, not sender authenticity, patient identity, review authority or clinical validity. These records do not enter a database or existing report pipeline.

## Build and check

From the repository root, with pinned Node/pnpm:

```sh
pnpm --filter @telesphoros/shared-types build
node scripts/test-fixtures/pgx-contracts.cjs          # generate PDFs/manifest from the three checked-in JSON sources
node scripts/test-fixtures/pgx-contracts.cjs --check  # refuse missing, changed or extra artifacts
pnpm --filter @telesphoros/shared-types test
```

The script's entry point parses through `parseSyntheticPgxPackage` before rendering. The pure `buildArtifacts` helper expects the already validated result and asserts that it matches the supplied JSON. No schema pass enables a runtime intake route. Component schemas alone do not establish the aggregate's patient/report/finding bindings.

## Prototype limits

- 256 KiB UTF-8 JSON limit before parsing; bounded collections and strings; exact draft version; strict unknown-field refusal. Only invented GENEA–GENED and `syn-` record IDs are accepted. Literal `synthetic: true`, `clinicalUse: not-approved`, `actionable: false` are required on the aggregate. These markers cannot prove a user supplied invented data: the public synthetic fixtures, not arbitrary uploads, are the permitted input here.
- Original source values are preserved. Typed evidence includes diplotype, allele, variant, measured activity and unresolved candidates. No-call, untested, unknown coverage and absent finding are distinct. One finding per manifest target; a future reconciliation service must handle repeats rather than selecting a convenient result.
- All JSON fields are rendered in stable order with labels. The PDF is a conformance specimen for engineering review. Its final physician-facing typography and partner-specific templates are future work. Built-in font output accepts printable ASCII only; other text is refused without modifying the source JSON. Output wraps at 82 characters, repeats binding/test-only labels on every page and refuses more than 100 pages; it never truncates evidence.
- Full ISO timestamps only in this draft. Date-only/precision-preserving dates, real gene/locus names, signatures, authenticated issuers, source text coordinates, multiple-report profiles, clinical phenotype translation, CPIC rules, FHIR, drug/variant terminology and real assay qualification require separately versioned work.
- Cross-record references and chronology are checked inside one package. The predecessor's existence, common patient/series and prior clinical state can only be verified against stored history in S2. This parser does not establish external history, current review, tenant authority or an audit-ledger write.

Plan: [S1](../../../docs/design/plans/pgx-contract-prototype.md). Verification: [record](../../../docs/verification/pgx-contract-prototype.md).
