# CPIC knowledge: format, sign-off and rules

> **Status (PR 5B-1):** the schemas, loader and engine are built and tested on **synthetic fixtures only**.
> `knowledge/cpic/` is empty on purpose: no real CPIC content has been fetched or reviewed yet. Until it
> has been, the system reports "no guideline loaded" instead of recommending anything.

## What this is

Clinical content is **data, not code**: versioned JSON files that a pharmacist reviews and signs. The
engine (`apps/backend/src/services/`) is a set of pure functions that read that data. It never writes
guideline wording itself.

```
knowledge/cpic/
  phenotypes/<id>.json       gene → how a diplotype becomes a phenotype
  guidelines/<id>.json       drug + gene → the recommendation for each phenotype
  gene-drug-pairs/           reserved (must stay empty in schema 1.0)
```

Only these folders, only plain `.json` files, and each file name must equal its `id`. **Anything else is an
error, never skipped**, because skipped knowledge looks exactly like "no guideline for this drug".

Test content lives elsewhere (`data/fixtures/knowledge/synthetic/`, invented genes `GENEA`–`GENED`). Every file
there is `synthetic: true`.

## File format (schema version `1.1`)

Every file starts with the same envelope:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `"1.1"` |
| `id` | lower-case letters, digits, dashes; equals the file name |
| `kind` | `gene-phenotype-map` or `guideline` |
| `synthetic` | `true` for invented test content. Refused in production; can never be signed off |
| `provenance` | `source`, `sourceUrl` (https), `retrievedAt` (date), `sourceVersion` |
| `review` | `{status: "unreviewed"}` or `{status: "reviewed", reviewedBy, reviewedAt, contentSha256}` |

**Gene map** (`kind: gene-phenotype-map`): `gene` and `phenotypes` (every canonical term the gene can have;
reported phenotypes and guideline cells may only use these). To accept a **diplotype** as input, also give
`alleles` (name, function, optional `activityValue`) and one `method`; a gene a lab reports as a phenotype needs
neither (give both or neither):

- `diplotype-table`: explicit rows `{diplotype, phenotype}`. Row order of the two alleles does not matter.
- `function-pair`: rows `{functions: [a, b], phenotype}` over the alleles' functional status. Order does not matter.
- `activity-score`: the two alleles' `activityValue`s are added and looked up in `ranges`
  (`min`/`max`, each with an explicit `…Inclusive`). Scores are compared in whole hundredths, so there is no
  floating-point error. Ranges must not overlap; gaps are allowed and mean "no phenotype".

**Guideline** (`kind: guideline`): `drug` (lower case), `guidelineVersion`, `title`, `genes` (one for a single-gene
table, several for a combined table), `supersedes` (ids of narrower guidelines for the same drug that a combined
table replaces; `[]` if none) and `recommendations`: one **cell** per combination of phenotypes:

- `when`: a phenotype for each of the guideline's genes (exactly those genes)
- `locator`: `table`, `row`, and `column` for a combined table, as the guideline prints them
- `verification`: `{state: "unverified"}`, `{state: "verified", verifiedBy, verifiedAt}` or `{state: "disputed", note}`
- `strength` (`Strong`, `Moderate`, `Optional`, `No recommendation`), `recommendationText` (copied verbatim, never
  rewritten) and optional `implication`

Only `verified` cells can ever be shown. The five outcomes, the reason codes and the rules above are in
[design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md).

Schema 1.1 limits (stated so nobody assumes more): **at most four genes per guideline; diploid genes written
`allele/allele`; no copy-number or structural variants.**

## Review and sign-off

1. Fetch or edit a file. Leave `review` as `{"status": "unreviewed"}`.
2. A pharmacist checks it against the source.
3. Run `pnpm --filter @telesphoros/backend knowledge:hash <file>` (after `pnpm build`; the path is relative to `apps/backend`). It prints the file's
   content hash: the whole file **except** the `review` block, with keys sorted, so formatting does not matter.
4. Replace `review` with `{"status": "reviewed", "reviewedBy": "...", "reviewedAt": "YYYY-MM-DD", "contentSha256": "<hash>"}`.

The hash binds the signature to the content. **Edit the file afterwards and the hash no longer matches: the
loader rejects it, in every environment**, until someone reviews it again.

## What the loader enforces (`services/knowledge/knowledge-loader.ts`)

- Everything above, plus: unique ids; one gene map per gene; one guideline per drug and set of genes (however the
  genes are ordered); every gene a guideline uses has a map; every phenotype in a cell is one that gene's map defines.
- `supersedes` is checked: the replaced guidelines must exist, be for the same drug, cover a smaller subset of the
  genes, not themselves supersede others (no chains), and be replaced by only one table.
- **Production** (`mode: "production"`, and also any mode that is not exactly `"non-production"`):
  refuses `synthetic` files and anything not `reviewed`. All problems are listed together.
- A test (`knowledge-loader.spec.ts`) loads the real `knowledge/cpic/` under the production rules, so
  committing unreviewed, edited or synthetic content there fails the build.
- `pnpm --filter @telesphoros/backend knowledge:verify -- --production` runs the same check by hand.

Wiring the loader into application start-up (`KNOWLEDGE_DIR`, refusing to process reports when loading
fails) arrives with the processing pipeline in PR 5B.

## What the engine returns

`evaluate(knowledge, geneInputs, {drugs?})` takes one input per occurrence of a gene in the report (a canonical
phenotype, a diplotype, a "no result" marker, or "unresolved") and returns the resolved state of each gene plus one
result per drug and guideline, each one of the five outcomes with its reason code, version stamps (`knowledgeSetId`,
guideline id and version, source URL) and, where a cell applies, its citation. Details, precedence and the choices
awaiting confirmation: [design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md).

## Not done yet

- Real CPIC content: needs `api.cpicpgx.org` reachable, then a pharmacist's review. Do not write guideline
  text by hand.
- A cross-check of every diplotype against CPIC's own published lookup (separate, gated step).
- The report adapter, the processing pipeline, database tables, the API and the UI (PR 5B-2 onward).
