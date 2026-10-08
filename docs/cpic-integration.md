# CPIC knowledge: format, sign-off and rules

> **Status (PR 5A):** the schemas, loader and engine are built and tested on **synthetic fixtures only**.
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

## File format (schema version `1.0`)

Every file starts with the same envelope:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `"1.0"` |
| `id` | lower-case letters, digits, dashes; equals the file name |
| `kind` | `gene-phenotype-map` or `guideline` |
| `synthetic` | `true` for invented test content. Refused in production; can never be signed off |
| `provenance` | `source`, `sourceUrl` (https), `retrievedAt` (date), `sourceVersion` |
| `review` | `{status: "unreviewed"}` or `{status: "reviewed", reviewedBy, reviewedAt, contentSha256}` |

**Gene map** (`kind: gene-phenotype-map`): `gene`, `alleles` (name, function, optional `activityValue`),
`phenotypes` (every term the tables may produce) and one `method`:

- `diplotype-table`: explicit rows `{diplotype, phenotype}`. Row order of the two alleles does not matter.
- `function-pair`: rows `{functions: [a, b], phenotype}` over the alleles' functional status. Order does not matter.
- `activity-score`: the two alleles' `activityValue`s are added and looked up in `ranges`
  (`min`/`max`, each with an explicit `…Inclusive`). Scores are compared in whole hundredths, so there is no
  floating-point error. Ranges must not overlap; gaps are allowed and mean "no phenotype".

**Guideline** (`kind: guideline`): `drug` (lower case), `gene`, `guidelineVersion`, `title`, and
`recommendations`: one row per phenotype with `strength` (`Strong`, `Moderate`, `Optional`,
`No recommendation`), `recommendationText` (copied verbatim, never rewritten) and optional `implication`.

Schema 1.0 limits (stated so nobody assumes more): **one gene per guideline; diploid genes written
`allele/allele`; no copy-number or structural variants; no multi-gene guidelines.**

## Review and sign-off

1. Fetch or edit a file. Leave `review` as `{"status": "unreviewed"}`.
2. A pharmacist checks it against the source.
3. Run `pnpm --filter @telesphoros/backend knowledge:hash <file>` (after `pnpm build`; the path is relative to `apps/backend`). It prints the file's
   content hash: the whole file **except** the `review` block, with keys sorted, so formatting does not matter.
4. Replace `review` with `{"status": "reviewed", "reviewedBy": "...", "reviewedAt": "YYYY-MM-DD", "contentSha256": "<hash>"}`.

The hash binds the signature to the content. **Edit the file afterwards and the hash no longer matches: the
loader rejects it, in every environment**, until someone reviews it again.

## What the loader enforces (`services/knowledge/knowledge-loader.ts`)

- Everything above, plus: unique ids; one gene map per gene; one guideline per drug and gene; every
  guideline's gene has a map; every guideline phenotype is one the map defines.
- **Production** (`mode: "production"`, and also any mode that is not exactly `"non-production"`):
  refuses `synthetic` files and anything not `reviewed`. All problems are listed together.
- A test (`knowledge-loader.spec.ts`) loads the real `knowledge/cpic/` under the production rules, so
  committing unreviewed, edited or synthetic content there fails the build.
- `pnpm --filter @telesphoros/backend knowledge:verify -- --production` runs the same check by hand.

Wiring the loader into application start-up (`KNOWLEDGE_DIR`, refusing to process reports when loading
fails) arrives with the processing pipeline in PR 5B.

## What the engine returns

`evaluate(knowledge, calls, {drugs?})` returns, for each gene, a phenotype and, for each drug, one result per
guideline. Either a **recommendation** (wording, `strength`, `guidelineId`, `guidelineVersion` and `sourceUrl`
as separate fields), or **indeterminate with a reason code**, never a guess:

| Code | Meaning |
| --- | --- |
| `UNPHASED_VCF`, `STRUCTURAL_VARIANT`, `MULTIALLELIC_SITE` | the parser could not make a call (reported by the parser) |
| `ALLELE_NOT_IN_DEFINITIONS`, `MALFORMED_DIPLOTYPE` | the diplotype text is unusable |
| `NO_GENE_DEFINITION` | no tables for this gene |
| `NO_PHENOTYPE_MAPPING` | the tables define no phenotype for this combination |
| `CONFLICTING_CALLS` | the report gives different results for one gene; none is picked |
| `GENE_NOT_IN_REPORT` | the guideline needs a gene the report lacks |
| `NO_MATCHING_GUIDELINE` | no loaded guideline covers the drug |
| `PHENOTYPE_NOT_IN_GUIDELINE` | the guideline has no row for this phenotype |

Messages for these codes are fixed text (`REASON_MESSAGES`). No genotype, diplotype or allele from a report is
ever copied into a reason, a message or an error.

## Not done yet

- Real CPIC content: needs `api.cpicpgx.org` reachable, then a pharmacist's review. Do not write guideline
  text by hand.
- A cross-check of every diplotype against CPIC's own published lookup (separate, gated step).
- Report parsers, the processing pipeline, database tables, the API and the UI (PR 5B–5D).
