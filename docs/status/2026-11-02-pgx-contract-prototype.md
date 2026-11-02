# Synthetic PGx report and assessment contracts

Date: 2026-11-02

Spec 032 slice S1 adds strict synthetic-only report/assessment schemas and a bounded JSON parser in shared types, with three invented paired JSON/PDF examples (resolved, uncertain, amended). The aggregate checks source/patient/revision references, assay coverage, typed uncertainty, joint-target completeness and withholding of recommendation wording on unsupported results. The deterministic fixture renderer produces separate laboratory and assessment documents plus an exact-byte artifact manifest.

No intake route, reader engine, UI, database, clinical content or clinical gate changes. A parse/hash cannot establish issuer authenticity, clinical approval or tenant authority. [Plan](../design/plans/pgx-contract-prototype.md), [examples](../../data/fixtures/pgx-contracts/README.md), [verification](../verification/pgx-contract-prototype.md).
