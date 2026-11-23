# Plan: spec 045, slice N2, the notice in the genomic profile

**Status**: **approved by the founder on 2026-11-21** (PR #439 merged; N2-D1 and N2-D2 decided below). Read against `main` at `5916aec`, which
has spec 045 (PR #433), slice A of spec 044 (the profile route, PR #427) and slice N1 (the gene modifier lists and their loader, PR #434).

## What N2 delivers

The genomic profile response gains the phenoconversion notices of spec 045 D3, worked out when the profile is read (D7) from the patient's
current medications and the loaded gene modifier lists. **Nothing else in the response changes** (PN-4): not a gene's status, not a word,
not a matching result. The screen that shows them is N3, after slice B.

## The response (additions only, all optional)

```
GenomicProfileDto += {
  modifierLists?: { loaded: boolean }                       // D8 and PN-6: which About text the screen shows
}
GenomicCheck += { contextNotices?: [ContextNotice] }        // on each medication row and on the ?rxcui= check
GenomicGene  += { contextNotices?: [ContextNotice] }        // on the gene's card (D9)
ContextNotice = {
  kind: "gene-modifier",
  gene,                                                     // the gene whose protein is affected, e.g. SLCO1B1
  medication: { rxcui, name, startRecorded: boolean },      // the patient's current, active medication that is listed
  effect: "inhibitor" | "inducer", strength: "strong" | "moderate",
  source: { listId, source, sourceVersion, sourceUrl, table, row | null }   // PN-7
}
```

The server returns facts, not sentences: the wording is the founders' (P-D6), as for every other word on the screen (slice B, G3). The
fields are optional because the frontend parses the profile strictly. A frontend released before the API never sees them, since no profile
screen exists before slice B.

## Rules (the builder, a pure function, unit-tested)

1. **Inputs.** Only the patient's **current, active** medications (D4). A stopped medication is never a modifier, even one stopped this
   month (P-D3). The loaded set is `GENE_MODIFIERS` (N1), or none.
2. **A notice on a check (D3).** For every gene G in the `genes` of the check's matching results, and every current active medication M with
   `modifiersOf(M.rxcui)` listing G: one notice (G, M). The checked medication may be M itself. Matching is the exact RxNorm id (PN-3). A
   combination product is never split (spec 039 D2), so it is a modifier only if the list states its own id, which an `IN`-only list never
   does. Slice B's sentence under every `MIN` row already says its ingredients are not checked.
3. **No matching result, no notice.** `no-guideline-loaded` has no results and so no genes: no notice, whatever the patient takes (PN-2).
4. **A notice on a gene card.** For every gene in `genes` and every current active medication listed against it: one notice. The card shows
   it whether or not any result used the gene.
5. **One notice per gene and medication**, in gene order and then medication name order (code units, as slice A sorts).
6. **`startRecorded`** is false when the medication has no start month: the screen then adds "Its start is not recorded." (D4).
7. **`modifierLists.loaded`** is true exactly when a set is loaded. Absent a set, no check or gene carries `contextNotices`, and the response
   is otherwise byte-identical to today's (PN-6).
8. **Nothing is written or logged** (PN-8): no ledger event, no stored notice, no value in a log line.

## Touched

| Path | Change |
| --- | --- |
| `packages/shared-types/src/genomic-profile.ts` | `contextNoticeSchema`; optional `contextNotices` on checks and genes; optional `modifierLists` |
| `apps/backend/src/genomic-profile/genomic-profile.builder.ts` | Rules 1 to 7; the input gains the loaded set and each medication's start month |
| `apps/backend/src/genomic-profile/genomic-profile.service.ts`, `.module.ts` | Inject `GENE_MODIFIERS` (optional); import `GeneModifiersModule` |
| `apps/backend/test/helpers/app.ts` | An option to load a synthetic modifier set for e2e tests (the API itself loads only signed lists) |
| Builder, service and e2e specs | Below |
| `docs/clinical-validation/genomic-profile-read.md`, a status fragment | The validation note gains the notice; one fragment |

The boundary test stays as it is: the genomic profile module imports `src/gene-modifiers/` (the set and its token), never `services/`.

## Not touched

No migration, route, role or gate change; no engine, knowledge file, Terraform or frontend. `GENE_MODIFIERS_DIR` stays unset in every
environment until N0's signed list exists, so on staging the response gains only `modifierLists: { loaded: false }`.

## Tests (working agreement 6)

- **Builder (PN-2):** a modifier of a gene the result used gives a notice; a modifier of a gene the result did not use, a **stopped**
  modifier, a modifier on **another patient's** list (service test), and a medication listed by name but not by RxNorm id give none.
- **Rule 3:** a `no-guideline-loaded` row next to a listed modifier gives none. **Rule 2:** the checked drug as its own modifier gives one.
- **PN-4:** the same input with and without a set gives responses equal field by field once `contextNotices` and `modifierLists` are removed.
- **PN-6:** without a set, no `contextNotices` anywhere and `modifierLists.loaded` false.
- **PN-7:** each notice carries the list's source, version, table and row exactly as loaded.
- **PN-5 (text):** the response contains no "safe", "no interaction" or "not affected"; slice B repeats it on rendered text.
- **e2e (memory and PostgreSQL with S3):** a synthetic set loaded through the test helper gives the notice on the route; the route writes
  nothing (the ledger's event count is unchanged).
- Each rule is removed in turn and a test must fail.

## How it will be verified

As for slice A, N1 and K2: the code is written here and **not run here** (founder decision P2); CI is the first run.

## Decisions for the founders

- **N2-D1. A drug being considered as a modifier of current medications.** **Decided 2026-11-21 (founder): a later slice**, with its own
  wording. N2 covers only current medications that change the gene a row rests on.
- **N2-D2. Inducers.** **Decided 2026-11-21 (founder): inhibitors and inducers both**, each named as what it is.

**Founder direction for the wording (N3, 2026-11-21):** the notice must be clear to a prescriber or pharmacist with no background in PGx, and
simple and enjoyable to work with. N2 serves that by sending plain facts in small parts (the gene, the medication, inhibitor or inducer,
strong or moderate, where the list says it), so N3 can say it in everyday words, with the technical evidence one step away.

P-D6 (the wording, English and Spanish) stays open and belongs to N3.
