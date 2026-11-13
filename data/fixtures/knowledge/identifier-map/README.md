# Identifier map (spec 039, IK-4)

`set/` is an invented schema 1.3 knowledge set; `expected.json` lists invented RxNorm ids in order and, for each, the answer
`mapRxNormIngredients` must give, written by hand before the function existed.

The set holds:

- `drugq`, one guideline (`drugq-genea`).
- `drugz`, a single-gene guideline (`drugz-genea`) and the combined table that supersedes it (`drugz-genea-geneb`). Both are listed, sorted
  by id, and the superseded one names its successor, so a caller cannot take it for a current file.
- A drug named `syn-rxcui-drugr`, which the drug-name schema allows, whose RxNorm id is `syn-rxcui-ingredient-r`. Its name is spelled like
  an identifier on purpose: looking up `syn-rxcui-drugr` must not find it, which a fallback to drug names would.

The ids, in order: two matched ids; an id no guideline states; the id spelled like that drug's name; that drug's real id; a well-formed
digits id, which this synthetic set does not hold (not matched, never "invalid"); a malformed id (`0042`, a leading zero); a plain drug name
(`drugq`, in neither identifier form); and a repeated id, answered again in its place.

"Not matched" means no guideline in this set states the id. It never means no guidance exists for the drug.

Every file is `synthetic: true` and uses the `syn-` identifier forms. Nothing here is CPIC, PharmGKB or PharmVar content or clinical advice.
