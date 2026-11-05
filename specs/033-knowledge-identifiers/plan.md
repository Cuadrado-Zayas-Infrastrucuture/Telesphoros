# Plan: knowledge identifiers

Follows [the spec](spec.md). One pull request, branched from `main` at `767bd0b5`. Nothing here is pushed, merged or released until the founder says so; the staging release pinned to `767bd0b5` starts first.

## Where each change goes

| Area | Change | Requirement |
| --- | --- | --- |
| `packages/cpic-schema/src/knowledge.ts` | Accept `schemaVersion` `1.2` or `1.3`. Add `rxcui` (guideline), `hgncId`, `origin` and `pharmvarVersion` (gene map) and per-cell `origin`, required on 1.3 and refused on 1.2. Identifier forms checked against `synthetic`. Unknown origin refused on a reviewed, non-synthetic file, beside the existing licence rule. | K2-1 to K2-3, K2-5 |
| `packages/cpic-schema/src/evaluation.ts` | Optional `identifiers` on drug results that carry a citation; absent means the knowledge was 1.2. | K2-6 |
| `apps/backend/src/services/knowledge/knowledge-loader.ts` | Production refuses a reviewed, non-synthetic 1.2 file. | K2-4 |
| `apps/backend/src/services/recommendation-engine/recommendation-engine.ts` | Copy the identifiers from the guideline file and its gene maps onto the result when all of them are 1.3. | K2-6 |
| `apps/backend/migrations/0071_evaluation_result_identifiers.{up,down}.sql` | Nullable columns, format checks, all-or-none constraint, labelled `compat: breaking` (new checks on an existing table); down refuses while any row carries identifiers. | K2-7 |
| `apps/backend/src/storage/postgres/ledger-records.repository.ts`, `apps/backend/src/ledger/projections.ts` | Write the columns; project them only when non-null. | K2-7, K2-8 |
| `data/fixtures/knowledge/synthetic-identifiers/` | New invented 1.3 set (genes and drugs reused from the synthetic vocabulary, `syn-` identifiers, every origin value represented). | K2-9 |
| `docs/cpic-integration.md`, `docs/clinical-validation/knowledge-identifiers.md`, `docs/status/2026-11-05-knowledge-identifiers.md` | Schema 1.3 section; validation note (identifiers never change an outcome); one status fragment. `docs/database.md` keeps no per-migration list, so it needs no entry. | all |

## Design notes

- **Why 1.3 sits beside 1.2 rather than replacing it.** The content hash and the knowledge set id are SHA-256 over the parsed file. Rewriting the existing fixtures as 1.3 would change the ids that PDF evaluation tests pin and the set baked into the staging image. Keeping 1.2 valid costs one union in the schema.
- **Why identifiers are stored on the result row, not only derivable from the knowledge set id.** The set id names the files, but `knowledge:locate` can only find them while the commit exists. A copy on the row, inside the ledger hash, keeps the identifiers with the record they describe. The columns are written once in the same transaction as the evaluation, and the existing append-only trigger forbids updates.
- **Why the hashed projection omits null identifiers.** It is the rule 0070 set for `sourceKind`: a record created before a field existed must hash exactly as it did. A test pins the key set of a result without identifiers to exactly the keys every result projection had before 0071.

## Verification

Each new guard is proved by removing it and watching its test fail, then restoring it.

| Tier | What it shows |
| --- | --- |
| `cpic-schema` unit | 1.2 files parse and hash as before; each 1.3 rule refuses its bad input; `syn-` and real forms refused in the wrong kind of file. |
| backend unit | Loader production refusal of reviewed non-synthetic 1.2; engine adds identifiers for 1.3 and leaves 1.2 results deep-equal to independently written expected values. |
| PostgreSQL 16 + S3 (Moto) | 0071 up and down on a real database; an evaluation from the 1.3 set stores the columns; constraints refuse malformed and partial identifiers; the down file refuses while populated; ledger walk clean; a 1.2 evaluation's projection unchanged. |
| repository gates | `pnpm typecheck`, `lint`, `test`, `build`, `test:infra`, `test:ci-config`; gitleaks 8.30.1 from the repository root. |

Local loop: Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 tools first on `PATH`, `LC_ALL=en_US.UTF-8`, `apps/backend/scripts/dev-postgres.sh start`, `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` set so no tier prints NOT RUNNING. Anything that cannot run is listed in the pull request as not run.
