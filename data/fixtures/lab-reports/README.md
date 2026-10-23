# Synthetic lab-report fixtures (test only)

Three small, original documents (`D01`, `D02`, `D08`) for the tests that drive the lab-report pipeline without the imported reader engine, which is
not part of this repository. They are **synthetic, written for this repository, and not derived from any laboratory report or from the engine's own
files.** They carry no patient data and no clinical content.

| Id | What it is | What the oracle expects (`tests/report_adapter/golden.json`) |
|---|---|---|
| `D01` | Two genes, each with a diplotype the test tables map and a result that agrees | evaluated; `CYP2C19 *1/*2`, `CYP2B6 *1/*1`, both corroborated |
| `D02` | One gene with an allele the test tables do not define (`*Z`) | evaluated; the engine reports `allele-not-in-definitions` |
| `D08` | A column table the reader cannot align | held, `alignment-unsupported` |

The ids match the oracle on purpose. They name different bytes than the engine's development reports of the same ids, which are kept private.

Each folder has `source.pdf`, `report.txt` and `capture.json`, the set the recorded-text capture runner reads (it checks the hashes, it does not parse
the PDF). The text is **recorded, not extracted**: nothing here tests real PDF extraction. The reader that turns the text into spans for these fixtures
is a test stand-in, `apps/backend/test/helpers/stand-in-reader.ts`; it tests the adapter, the engine and everything after them, not the real reader.

`.gitattributes` turns line-ending conversion off: the hashes in `capture.json` are of the exact bytes.

Regenerate or check: `node scripts/test-fixtures/lab-report-fixtures.cjs [--check]`. The bytes are deterministic (no dates, no random ids).
