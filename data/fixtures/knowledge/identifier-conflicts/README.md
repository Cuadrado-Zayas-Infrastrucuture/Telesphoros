# Identifier conflicts (spec 039, IK-1 and IK-2)

Invented knowledge sets for the loader's identifier rules. Each folder is a complete small set that loads outside production except for
the one conflict it holds. `expected.json` gives, for each folder, the exact problems the loader must report, written by hand before the
rules existed.

| Folder | What it holds | Expected |
| --- | --- | --- |
| `one-drug-two-ids/` | Two 1.3 guidelines for `drugq` (genes `GENEA`, `GENEB`) stating different RxNorm ids | refused, IK-1 |
| `two-drugs-one-id/` | `drugq` and `drugr` stating one RxNorm id | refused, IK-1 |
| `two-genes-one-id/` | Gene maps `GENEA` and `GENEB` stating one HGNC id | refused, IK-1 |
| `half-identified-drug/` | A 1.3 and a 1.2 guideline for `drugq` | refused, IK-2 |
| `control/` | `drugq` in two 1.3 files with one RxNorm id; `drugs`, a 1.3 guideline over the 1.2 gene map `GENEC`; `drugt`, a drug whose only file is 1.2 | loads, no problems |

The loader reads `guidelines/` before `phenotypes/`, each in name order, so the first path a message names is the first file read; for
IK-2 the 1.2 file is named first. In `control/`, `drugs` has an RxNorm id but its results carry no identifiers, because `GENEC` is 1.2 (as
`identifiersFor` already decides); `drugt` has no RxNorm id, so no id finds it.

Every file is `synthetic: true` and uses the `syn-` identifier forms. Nothing here is CPIC, PharmGKB or PharmVar content or clinical advice.
