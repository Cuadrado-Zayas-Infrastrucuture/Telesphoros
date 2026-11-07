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

## File format (schema versions `1.2` and `1.3`)

Every file starts with the same envelope:

| Field           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `"1.3"` (current) or `"1.2"`. A 1.2 file parses exactly as before, so its content hash is unchanged; production refuses it (below).                                                                                                                                                                                                                                                                                                                                                                                    |
| `id`            | lower-case letters, digits, dashes; equals the file name                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kind`          | `gene-phenotype-map` or `guideline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `synthetic`     | `true` for invented test content. Refused in production; can never be signed off                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `provenance`    | `source`, `sourceUrl` (https), `retrievedAt` (date), `sourceVersion`, `license` (`cc0-1.0`, `cc-by-4.0`, `cc-by-sa-4.0`, `proprietary` or `unknown`) and `redistribution` (`allowed`, `restricted` or `unknown`). A **reviewed, non-synthetic** file may not say `unknown` for either: the reviewer states what the source's license allows before signing (`knowledge:hash` refuses to print a hash until then). Drafts and synthetic files may. The fields record what the reviewer read; they do not grant a right. |
| `review`        | `{status: "unreviewed"}` or `{status: "reviewed", reviewedBy, reviewedAt, contentSha256}`, plus (schema 1.3) `signatures: [{keyId, algorithm: "ecdsa-p256-sha256", signature}]`                                                                                                                                                                                                                                                                                                                                        |

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

### Schema 1.3: identifiers and origin

Schema 1.3 ([spec 033](../specs/033-knowledge-identifiers/spec.md)) adds standard identifiers and says where content came from. Each field is
required on a 1.3 file and refused on a 1.2 file.

| Field             | Where                                    | Meaning                                                                                                                                 |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `rxcui`           | guideline                                | The drug's RxNorm ingredient id. One per file, because a file covers one drug.                                                          |
| `origin`          | every guideline cell, and every gene map | `cpic`, `pharmgkb`, `pharmvar` or `unknown`: which source's content this is, so the terms that apply to each cell are recorded with it. |
| `hgncId`          | gene map                                 | The gene's HGNC id, e.g. `HGNC:` followed by digits.                                                                                    |
| `pharmvarVersion` | gene map that lists `alleles`            | The PharmVar release the alleles were defined in. Absent on a phenotype-only gene.                                                      |

- **Identifier forms.** A non-synthetic file uses the real forms (an RxCUI is digits; `HGNC:` plus digits; a dotted release such as `6.2.1`).
  A synthetic file must use invented forms (`syn-rxcui-…`, `syn-hgnc-…`, `syn-pharmvar-…`), and a real-form identifier in a synthetic file is
  refused, so test content can never carry, or collide with, a real identifier.
- **Origin.** A reviewed, non-synthetic file may not say `unknown` for any origin, exactly as for `license` and `redistribution`, so
  `knowledge:hash` prints no hash for it and the loader refuses it in every mode.
- Synthetic 1.3 content lives in `data/fixtures/knowledge/synthetic-identifiers/`. The real formats of these identifiers are to be confirmed
  against CPIC's own fields before the first real file is signed.

Schema 1.1 limits (stated so nobody assumes more): **at most four genes per guideline; diploid genes written
`allele/allele`; no copy-number or structural variants.**

## Review and sign-off

1. Fetch or edit a file. Leave `review` as `{"status": "unreviewed"}`.
2. A pharmacist checks it against the source, including the source's license: set `provenance.license` and `provenance.redistribution` to what the source states (not `unknown`).
3. Run `pnpm --filter @telesphoros/backend knowledge:hash <file>` (after `pnpm build`; the path is relative to `apps/backend`). It prints the file's
   content hash: the whole file **except** the `review` block, with keys sorted, so formatting does not matter.
4. Replace `review` with `{"status": "reviewed", "reviewedBy": "...", "reviewedAt": "YYYY-MM-DD", "contentSha256": "<hash>"}`.

The hash binds the signature to the content. **Edit the file afterwards and the hash no longer matches: the
loader rejects it, in every environment**, until someone reviews it again.

5. **Two signers sign it (audit CLIN-01).** The hash alone proves nothing about who reviewed: anyone who edits a cell can recompute it and write
   any name in `reviewedBy`. So each of two signers runs
   `pnpm --filter @telesphoros/backend knowledge:sign -- <file> --key-id <id> --kms-key <arn>` with their own KMS key (key spec
   `ECC_NIST_P256`, usage `SIGN_VERIFY`). It signs the text `telesphoros-knowledge/1`, the file id and the content hash, one per line, checks
   the result against the key's public key, and prints an entry to add to `review.signatures`. It writes nothing. The signatures sit inside
   the `review` block, outside the hash they sign.

Which signers count is not in the repository: `KNOWLEDGE_SIGNER_KEYS` (a JSON object of key id to P-256 SPKI PEM public key) is set where the
process runs, so write access to the files is not enough to sign them.

## What the loader enforces (`services/knowledge/knowledge-loader.ts`)

- Everything above, plus: unique ids; one gene map per gene; one guideline per drug and set of genes (however the
  genes are ordered); every gene a guideline uses has a map; every phenotype in a cell is one that gene's map defines.
- `supersedes` is checked: the replaced guidelines must exist, be for the same drug, cover a smaller subset of the
  genes, not themselves supersede others (no chains), and be replaced by only one table.
- **Production** (`mode: "production"`, and also any mode that is not exactly `"non-production"`):
  refuses `synthetic` files, anything not `reviewed`, and any schema 1.2 file (it states no origin). A reviewed 1.3 file needs valid
  signatures from two distinct signers in `KNOWLEDGE_SIGNER_KEYS`; an unknown signer, the same signer twice, a signature over other
  content or another file's id, or no configured keys are each refused. All problems are listed together.
- The signers that verified are kept with the file, and every citation from it carries them (`citation.signedBy`), inside the ledger hash.
- A test (`knowledge-loader.spec.ts`) loads the real `knowledge/cpic/` under the production rules, so
  committing unreviewed, edited or synthetic content there fails the build.
- `pnpm --filter @telesphoros/backend knowledge:verify -- --production` runs the same check by hand.
- An evaluation stores only the knowledge set id. `pnpm --filter @telesphoros/backend knowledge:locate -- <id>` finds
  the git commits whose `knowledge/cpic` loads to that id, with the same loader, so a reviewer can get back to the exact
  files. It reads git only and prints no file content. It can find only commits that still exist: a history rewrite
  can remove them, and the id is not archived anywhere else.

Wiring the loader into application start-up (`KNOWLEDGE_DIR`, refusing to process reports when loading
fails) arrives with the processing pipeline in PR 5B.

## What the engine returns

`evaluate(knowledge, geneInputs, {drugs?})` takes one input per occurrence of a gene in the report (a canonical
phenotype, a diplotype, a "no result" marker, or "unresolved") and returns the resolved state of each gene plus one
result per drug and guideline, each one of the five outcomes with its reason code, version stamps (`knowledgeSetId`,
guideline id and version, source URL) and, where a cell applies, its citation. When the guideline and every gene map it reads are
schema 1.3, a result with a citation also carries `identifiers` (the RxCUI, each gene's HGNC id and PharmVar release, and the cell's origin).
They are copied, never used to choose a cell or an outcome, and stored on the result row inside the ledger hash (migration 0071); a result
from 1.2 knowledge carries none and hashes exactly as before. Details, precedence and the choices
awaiting confirmation: [design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md).

**Where an input came from (`callSource`).** Each input the report adapter emits carries `callSource: 'lab-report'`: the value is what the lab printed, read by the adapter. It is stored with the input (so it is inside the ledger-hashed evaluation record) and shown in the evaluation detail's `geneInputs`; it is **not** on the resolved gene state the engine returns, and the engine and the knowledge files never read it. The field is optional in the schema because evaluations stored before it existed carry none and their hashes were taken without it; absence means `lab-report`, the only source there was. Any other value (an external genotype caller, for example) is refused until it is added deliberately, in its own change.

## Not done yet

- Real CPIC content: needs `api.cpicpgx.org` reachable, then a pharmacist's review. Do not write guideline
  text by hand.
- A cross-check of every diplotype against CPIC's own published lookup (separate, gated step).
- The report adapter, the processing pipeline, database tables, the API and the UI (PR 5B-2 onward).
