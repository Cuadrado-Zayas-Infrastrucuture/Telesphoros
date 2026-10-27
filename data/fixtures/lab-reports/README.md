# Synthetic lab-report fixtures (test only)

Twelve small, original documents (`D01` to `D12`) for the tests that drive the lab-report pipeline without the imported reader engine, which is
not part of this repository. They are **synthetic, written for this repository, and not derived from any laboratory report or from the engine's own
files.** They carry no patient data and no clinical content.

| Id | What it is | What the oracle expects (`tests/report_adapter/golden.json`) |
|---|---|---|
| `D01` | Two genes, each with a diplotype the test tables map and a result that agrees | evaluated; `CYP2C19 *1/*2`, `CYP2B6 *1/*1`, both corroborated |
| `D02` | One gene with an allele the test tables do not define (`*Z`) | evaluated; the engine reports `allele-not-in-definitions` |
| `D03` | A mapped diplotype with a result that is not one of the tables' terms | evaluated; the result is untrusted, the gene unresolved |
| `D04` | A mapped diplotype and no result | evaluated; `no-reported-result`, the gene unresolved |
| `D05` | A diplotype field that is present and empty, and no result | evaluated; the gene is null (`empty-field`) and the engine holds it |
| `D06` | The same gene line twice, word for word | evaluated; `duplicate-identical` |
| `D07` | The same gene twice with different diplotypes | evaluated; `duplicate-gene-conflict` |
| `D08` | A column table the reader cannot align | held, `alignment-unsupported` |
| `D09` | D01's genes and results among lines the reader ignores | evaluated, as D01 |
| `D10` | Genes and values listed with nothing tying a value to a gene | evaluated; the reader abstains, every gene `association-abstained` |
| `D11` | As D10, values in another order and no results | evaluated, as D10 |
| `D12` | A gene line with a field the reader does not know | held, `unaccounted-text` |

The ids match the oracle on purpose. They name different bytes than the engine's development reports of the same ids, which are kept private.

Each folder has `source.pdf`, `report.txt` and `capture.json`, the set the recorded-text capture runner reads (it checks the hashes, it does not parse
the PDF). The text is **recorded, not extracted**: nothing here tests real PDF extraction. The reader that turns the text into spans for these fixtures
is a test stand-in, `apps/backend/test/helpers/stand-in-reader.ts`; it tests the adapter, the engine and everything after them, not the real reader.

What the fixtures do not prove: the line formats (`Gene: ... | Diplotype: ... | Result: ...`, and the `Layout: unassociated-values` lists of D10 and D11)
are the stand-in's own, invented for these tests. A matching outcome here shows that the adapter, the engine and the records handle each case the
oracle names; it says nothing about whether the real reader finds that case in a real laboratory report.

`.gitattributes` turns line-ending conversion off: the hashes in `capture.json` are of the exact bytes.

Regenerate or check: `node scripts/test-fixtures/lab-report-fixtures.cjs [--check]`. The bytes are deterministic (no dates, no random ids).
