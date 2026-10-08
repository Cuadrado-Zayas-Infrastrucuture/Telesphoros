# Outcomes, reason codes and cell verification (frozen vocabulary)

> **Status:** proposed for founder review in PR 5B-1. Once approved this is frozen: later work (the report
> adapter, the records and API, the dashboards) refers to these names and may not invent others without
> changing this document. The code lives in `packages/cpic-schema/src/vocabulary.ts`; a test pins the two together.

## Why this exists

Different labs translate genotypes into phenotypes differently, and a guideline's published tables are read
cell by cell. A wrong cell, a silently resolved ambiguity, or a "no result" read as "normal" looks exactly like a
correct answer. So the system never shows a recommendation unless a **verified** cell applies to **canonical**
values, and every other situation is a distinct outcome that tells the reader what happened and what to do.
(No numeric claims are made here about how often labs disagree; any such figure must be sourced before it is
added to this repository.)

## The five outcomes

They must look and behave differently everywhere (icon, shape, colour and wording; never colour alone).

| Outcome | Meaning | Shows guideline wording? |
| --- | --- | --- |
| `shown` | Every gene resolved to a canonical phenotype and a **verified** cell applies | Yes, verbatim, with its citation |
| `held` | A person must act before anything can be shown | **Never** |
| `abstained` | The report lists values with no key tying them to genes; nothing was assigned | **Never** |
| `no-published-recommendation` | The guideline was consulted and publishes no recommendation for this case | Only when a verified cell itself says "No recommendation" |
| `no-guideline` | No loaded guideline covers the drug | n/a |

A result is `shown` only if all of these hold, which a test checks over every combination of states for a
two-gene table: each gene is a clean canonical phenotype; the guideline has a cell for exactly that combination;
that cell is `verified`. The wording of an unverified or disputed cell is never placed in any field, not even to a
reviewer-facing one; the result carries only the cell's location.

## Gene states

Per gene, after duplicates, sentinels and diplotypes have been resolved:

| State | Meaning |
| --- | --- |
| `canonical` | A phenotype that is one of the gene's own canonical terms (exact match; no case folding or synonyms here) |
| `absent` | The report does not mention the gene (or the adapter produced nothing for it) |
| `null` | The report says "no result" (or similar) where a value should be |
| `unresolved` | There is a value or values, but they cannot be used (see the reason) |

## Reason codes

Every non-`shown` result carries exactly one. Messages and reviewer actions are fixed text; none ever contains a
value from a report.

| Code | Outcome | Plain meaning | Reviewer action |
| --- | --- | --- | --- |
| `duplicate-gene-conflict` | held | The same gene appears more than once with different values | Obtain ordering or supersession evidence, or a corrected report |
| `duplicate-identical` | held | The same gene appears more than once with identical values | Confirm it is a repeated summary line |
| `sentinel-literal-in-source` | held | The report says "no result" in place of a value | Ask the lab whether the test failed |
| `other-gene-unresolved` | held | The value is not a recognized phenotype (unfamiliar wording, or a genotype only) | Obtain the phenotype from the lab |
| `out-of-review-scope` | held | The guideline cell exists but has not passed review | none yet |
| `cell-disputed` | held | The guideline cell is under dispute | Resolve through the cell review process (independent second person) |
| `gene-absent` | held | The report has no result for a gene this guideline needs | Obtain the missing gene result from the lab |
| `malformed-diplotype` | held | A diplotype is not "allele/allele" | Obtain a correctly formatted result |
| `allele-not-in-definitions` | held | An allele is not in the reviewed definitions | Obtain the phenotype, or add the allele through the reviewed definition process |
| `no-phenotype-mapping` | held | The tables define no phenotype for this allele combination | Obtain the phenotype from the lab |
| `no-gene-definition` | held | The system has no definitions for this gene | Obtain the phenotype; the gene needs a reviewed definition |
| `association-abstained` | abstained | Values listed with no key tying them to genes | Request a corrected or differently laid out report |
| `no-published-recommendation` | no-published-recommendation | The guideline publishes none for this case | none |
| `no-guideline-for-drug` | no-guideline | No loaded guideline covers the drug | none |

The last four rows of gene-level problems exist because the engine can also be fed a **diplotype** (a structured
lab feed). A report read from a PDF gives phenotypes.

**Precedence.** When several genes behind one result have different problems, the result carries the first that
applies in this order, and holds come before abstention (if a person is needed, say so):
`duplicate-gene-conflict`, `duplicate-identical`, `sentinel-literal-in-source`, `other-gene-unresolved`,
`malformed-diplotype`, `allele-not-in-definitions`, `no-phenotype-mapping`, `no-gene-definition`, `gene-absent`,
`association-abstained`. (`out-of-review-scope` and `cell-disputed` belong to a cell, not a gene, and arise only
when every gene is clean.) All the genes' individual states are listed in the result either way.

**Codes a caller may attach (amended 2026-10-08).** The engine accepts a gene the caller could not resolve together with
one reason code, and only from a short list: `other-gene-unresolved` and `association-abstained`. The report adapter
(`docs/design/report-adapter-spec.md`, section 5.4) also needs `duplicate-identical` and `duplicate-gene-conflict`:
only the adapter still has the literal facts (diplotype text, result text, field presence) that decide which one applies.
No code is added and no meaning changes; the list of codes an adapter may attach grows from two to four, and the change in
`packages/cpic-schema/src/vocabulary.ts` is made, with its pinning test, together with the adapter code. The engine's own
duplicate rule stays as the backstop for input that does not come from the adapter.

## Cells: citation and verification

Every guideline cell carries a **locator** (the table, row and, for a combined table, column as the guideline prints
them) so a person can find it, and a **verification state**:

| State | Meaning | Effect |
| --- | --- | --- |
| `unverified` | Not yet rechecked against the published source | The result is held as `out-of-review-scope` |
| `verified` | Rechecked, by whom and when | May be shown |
| `disputed` | Someone disputes its position or content, with a note | The result is held as `cell-disputed` |

This is separate from the **file** sign-off in `docs/cpic-integration.md` (a reviewer signs a whole file's content;
the verification state is about each cell's position in the source). Both are needed in production.

### Disputed cells: who may change them

Because disagreement between interpretations is the expected failure in this domain, a disputed cell will occur.
Rules the later records-and-API work must implement:

1. A cell can only leave `disputed` through a recorded decision that states the evidence, by someone other than
   the person who raised the dispute (an independent second person).
2. While disputed it is held by default; nothing downstream can override that.
3. Every state change is a new record that points at the previous one; nothing is edited in place.

## Combined tables and no fallback

A guideline lists the genes it is read by (one or several) and each cell gives a phenotype for each of them. A
combined table may declare that it **supersedes** narrower single-gene guidelines for the same drug. Those are then
never shown on their own: if the combined table cannot be applied (a gene is absent, a cell is unverified,
disputed or missing), the drug's result is held or has no published recommendation. **There is no fallback to a
narrower row**, because the narrower row can contradict the combined one.

## Retired 5A codes

Anything recorded under the 5A names stays interpretable through this mapping (`RETIRED_REASON_CODES` in code):

| 5A code | Now |
| --- | --- |
| `CONFLICTING_CALLS` | `duplicate-gene-conflict` |
| `GENE_NOT_IN_REPORT` | `gene-absent` |
| `NO_MATCHING_GUIDELINE` | `no-guideline-for-drug` |
| `PHENOTYPE_NOT_IN_GUIDELINE` | `no-published-recommendation` |
| `MALFORMED_DIPLOTYPE` | `malformed-diplotype` |
| `ALLELE_NOT_IN_DEFINITIONS` | `allele-not-in-definitions` |
| `NO_PHENOTYPE_MAPPING` | `no-phenotype-mapping` |
| `NO_GENE_DEFINITION` | `no-gene-definition` |
| `UNPHASED_VCF`, `STRUCTURAL_VARIANT`, `MULTIALLELIC_SITE` | removed (the VCF path is not built) |

## Choices made here that the founder should confirm

These are defaults chosen to be conservative. Each is one line in the code or fixtures to change.

1. **Duplicates are always held**, even identical ones (`duplicate-identical`), matching the product design. The
   duplicate-gene policy (R03) is still listed as an open validation item, so this is provisional.
2. **A verified cell whose strength is "No recommendation"** is reported as `no-published-recommendation`
   (with its citation and wording), not as `shown`.
3. **A gene absent from the report holds the drug** (`gene-absent`) rather than silently producing nothing.
4. **Unverified and disputed cells never expose their wording**, only their location.
5. **Phenotype terms must match a gene's canonical terms exactly.** Mapping lab wording to canonical terms belongs
   to the report adapter (next slice), not to the engine.

## Not decided here

The adapter (turning what a report says into gene states: missing versus empty, duplicate equality, what counts as
a "no result" literal) and the correction and supersession model for stored results are separate specifications,
written and approved before their code.
