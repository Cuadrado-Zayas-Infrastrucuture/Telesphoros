# Report adapter specification

> **Status: approved (PR 12) and amended on 2026-10-08 (this revision).** The amendment reconciles the specification with
> the second Codex hand-off (`pgx-claude-handoff-v1`), whose design rules R02 to R07 the founder confirmed as current. Where
> they differ from the first version of this document, the hand-off's rule now governs; every change is listed in section 12
> and marked **[amended]** in the text. The reader (PR 13) is merged; the adapter code follows this revision.

## 1. What the adapter is, and what it is not

```
stored report text ──► ReportReader (Python sidecar, 5B-2a) ──► ReaderResult
                                                                    │
                  accepted capture record (human) ─────────────────►│
                  pinned reader / Poppler versions ─────────────────►▼
                                                              ReportAdapter (TypeScript, pure)
                                                                    │
                                          ┌─────────────────────────┴───────────────┐
                                          ▼                                         ▼
                              AdapterResult.disposition = 'held'      AdapterResult.disposition = 'evaluated'
                              (report-level hold: no drug results)    geneInputs ──► evaluate() (5B-1, unchanged)
```

- The **reader** finds spans of text in one stored text of a report. It does not know any guideline. It never decides what
  a value means.
- The **adapter** turns what the reader found into the engine's existing input contract (`GeneInput[]`, see
  `packages/cpic-schema/src/evaluation.ts`). It never reads the report itself and never calls a guideline.
- The **engine** (5B-1) is **not changed** by this slice, and **the frozen vocabulary is not extended**: no new gene
  state and no new reason code in `docs/design/outcomes-and-reason-codes.md`.
- Everything is **fail closed**. Anything the adapter cannot account for becomes a hold that names what a person has to do.
  Nothing is guessed, defaulted, case-folded or repaired.

Out of scope here, deliberately: reading PDFs directly (the reader works on stored text that a person has accepted),
coordinates or OCR, genes outside the reader's registry, medication or population context, any use of reports for
training. Hand-off files are synthetic and assistant-authored; everything derived from them is **TEST ONLY: not clinical
content, not human-adjudicated**.

## 2. Inputs the adapter requires

The adapter is a pure function of these. If any is missing or inconsistent, the result is a report-level hold (section 6).

| Input | Source | Must satisfy |
| --- | --- | --- |
| `ReaderResult` | the reader: both the **packet** and the **projection** it produced (`process_source` returns both) | Passes the checks in section 3 |
| `CaptureAcceptance` | append-only record written when a person chooses "Accept capture" | `decision = accepted`; `textSha256` equals the reader's `sourceRef.sourceHash`; `popplerVersion` equals the pinned version; reviewer identity present (Cognito `sub` and tenant). The store itself is slice 5B-3; in 5B-2a it is an interface with an in-memory implementation |
| `PinnedReader` | a constant committed to the repository | `generatorVersion`, `generatorCodeHash`, `grammarHash`, `offsetContractHash`, `fieldBoundaryPolicyHash` equal the packet's. Changed only by a reviewed PR |
| `PhenotypeResolver` | the engine's `mapPhenotype`, bound to the loaded knowledge set | Used only to reconcile a diplotype with a stated result (section 5.2) |

The pinned Poppler version is **26.03.0** (`pdftotext -layout`). Output from any other version is not comparable, so a
capture made with another version is never accepted automatically.

## 3. Checks on the reader's output (before any mapping)

Each failure is a report-level hold with the code in brackets. Nothing downstream runs.

1. The capture was accepted and its text hash matches the packet's source hash (`capture-not-accepted`, `capture-hash-mismatch`).
2. The recorded Poppler version is the pinned one (`poppler-version-mismatch`).
3. The packet's build bindings equal `PinnedReader` (`reader-binding-mismatch`).
4. The packet is well formed: its `packetHash` re-computes, and every span's text equals the source slice it points at
   (`packet-invalid`). The reader already replays its own packet; the adapter re-checks the parts it relies on.
5. **Disjoint evidence** (section 4) holds (`evidence-overlap`).
6. The reader did not itself hold (section 6, reader reasons).

## 4. Disjoint gene and value evidence

A span is a half-open range `[start, end)` of Unicode scalars in the accepted text. In an accepted packet:

- no character is used as evidence for two different things: gene spans and value spans never overlap each other, and no
  two value spans overlap;
- every value belongs to exactly one gene occurrence, and only through an **allowed edge** the reader recorded
  (`frame` → value, with the rule that justified it). A value near a gene is not thereby tied to it;
- a value span never lies inside another occurrence's gene token.

Offsets and pages never take part in deciding whether two occurrences are "the same" (section 5.4).

## 5. Mapping to engine inputs

The reader's registry names exactly **CYP2C19** and **CYP2B6**. A report that mentions anything else is not fully
accounted for by the reader and is held by it (`unaccounted-text`). Extending the registry is a reviewed change.

### 5.1 Vocabulary used below

An **occurrence** is one gene frame: `(gene, occurrenceIndex)`, where `occurrenceIndex` is 0-based in source order
**within that gene** and is meaningful only for that exact text hash. Each occurrence may carry a **diplotype** span, a
**reported result** span, both, or neither.

- A role is **missing** when the reader found no span for it and recorded nothing about it.
- A role is **empty** when the reader recorded that its label is present with no value (`present-empty-field`, taken from the
  packet's diagnostics: the projection alone does not carry it).
- A reported result is **canonical** when its text, exactly, is one of that gene's canonical phenotype terms (no case
  folding, no synonyms: the same rule the engine applies). It is an **unavailable value** when it matches one of the seven
  tokens by the exact procedure in section 5.5 **[amended]**. Otherwise it is **non-canonical**; a value wrapped in quotation
  marks is non-canonical, because the quotation marks are part of the value.

### 5.2 One occurrence to engine input

`mapPhenotype` below means the engine's own diplotype mapping for that gene; the adapter never maps alleles itself.

| Diplotype | Reported result | Emitted input(s) for the occurrence | Why |
| --- | --- | --- | --- |
| present, **cannot** be mapped (malformed, unknown allele, no mapping, no gene definition) | anything | `diplotype` | The engine then reports its own precise reason (`malformed-diplotype`, `allele-not-in-definitions`, `no-phenotype-mapping`, `no-gene-definition`) |
| present, maps to phenotype P | missing | `unresolved` with `other-gene-unresolved` | **[amended]** A diplotype with no reported result is unresolved (rule R04); the engine's own message for this code already reads "or a genotype only". The diplotype stays in the audit trail and is not used to assign a phenotype |
| present, maps to P | canonical and equal to P | `diplotype` | The stated result corroborates it |
| present, maps to P | canonical and **different** from P | **two** inputs: `diplotype` and `canonical` | They differ, so the engine's duplicate rule holds the gene as `duplicate-gene-conflict` |
| present, maps to P | non-canonical, unavailable, or empty | `unresolved` with `other-gene-unresolved` | The report says something about the result that cannot be checked against the diplotype, so it is not trusted |
| missing | canonical | `canonical` | |
| missing | unavailable (section 5.5) | `null` | Report says "no result": engine reports `sentinel-literal-in-source`. **[amended]** the match is by the seven-token procedure; a quoted value never matches |
| missing | **empty** | `null` | A declared field with nothing in it is a "no result" |
| missing | non-canonical (including a quoted value, and the literals "no result" and "sin resultado") | `unresolved` with `other-gene-unresolved` | Unfamiliar wording: ask the lab |
| missing | missing | `unresolved` with `other-gene-unresolved` | The gene is named but nothing is stated about it. Not `absent`: the report does mention it |

Empty roles follow one rule in both directions. A role that is **empty** while the other role has a value is not trusted:
the gene is `unresolved` with `other-gene-unresolved` (this is the "empty" cell in the table above, and it applies equally to
an empty diplotype beside a result). An empty role with nothing else stated, or both roles empty, is `null`.

### 5.3 Reader status to adapter result

| Reader status | Meaning | Adapter result |
| --- | --- | --- |
| `projected` | Every non-whitespace character of the report is accounted for by registered patterns and every gene is tied to its values | `evaluated`: emit inputs per 5.2, then call the engine |
| `source-abstained` (`registered-source-ambiguity`) | The report lists genes and values with no key tying them together (registered patterns: inline lists, a cross-page dangling result) | `evaluated`: **each gene** the reader lists gets `unresolved` with `association-abstained`; listed values are dropped. The engine reports `abstained` for drugs on those genes. Nothing is assigned |
| `held` | The reader could not account for the text | `held` at report level: **no drug results** |

The engine keeps its own precedence: a gene problem that needs a person (`held`) beats an abstention on another gene.

### 5.4 Duplicates: when two occurrences are "equal" **[amended]**

Every gene that occurs more than once is held; nothing is collapsed to a chosen value (rule R03, option A). The adapter,
not the engine, decides which duplicate code applies, because only the adapter still has the literal facts. Structural
and evidence checks (section 3) run first; duplicates are compared **before** any unavailable-value matching.

An occurrence is summarized as: the gene symbol; the literal diplotype text or "none"; the literal reported-result text or
"none"; and a **result basis**: `reported-value` (a result span exists), `empty-field` (the result label is present with
nothing after it), `no-reported-result` (a diplotype and no result field), or `nothing-stated`. Two occurrences are
**identical** only if every part is byte-equal as UTF-8: no case, spacing, quotation or phenotype normalization. Differently
worded unavailable tokens are different; missing and empty are different.

- All occurrences of the gene identical: **one** input for the gene, `unresolved` with `duplicate-identical`.
- Otherwise: **one** input, `unresolved` with `duplicate-gene-conflict`.

All occurrences stay in `occurrences` (the audit trail). This needs one change to the frozen vocabulary, also **[amended]**:
the adapter may attach the two duplicate codes (`duplicate-identical`, `duplicate-gene-conflict`) in addition to
`other-gene-unresolved` and `association-abstained`. The engine's own duplicate rule remains as a backstop for input that
does not come from this adapter. The change is recorded in `docs/design/outcomes-and-reason-codes.md` and made in code with
the adapter.

### 5.5 Unavailable values (rule R06) **[amended]**

Exactly seven tokens, already normalized, and no others: `not available`, `not reported`, `pending`, `no disponible`,
`resultado no disponible`, `no reportado`, `pendiente`. A new token needs a source example, a version change, conformance
cases and review.

A reported result is compared with them after **only** this fixed sequence, in order: Unicode NFC; replace every run of
Unicode White_Space code points (U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F,
U+205F, U+3000) with one U+0020; trim U+0020 from both ends; Unicode default full case folding; remove exactly one terminal
ASCII period; **no trim afterwards**. The reported text itself is never changed. No accent folding, quote stripping, fuzzy or
substring matching, or translation.

| Source value | Outcome |
| --- | --- |
| `not available` | match |
| `NOT AVAILABLE.` | match |
| `not available .` | no match (a space remains after the period is removed) |
| `not available..` | no match (one period remains) |
| `"not available"` (with its quotation marks) | **no match**: quotation marks are part of the value (this is D03) |
| `no result`, `sin resultado` | no match; non-canonical, so held |
| `Indeterminate` | no match; a phenotype term (canonical when the gene's own list includes it) |

Implementation requirements: the matcher is its own pure module with a frozen conformance table. Node must report Unicode
16.0 (`process.versions.unicode`), and the module refuses to load otherwise, so a runtime that does not conform cannot
silently change results. JavaScript has no full case fold, and all seven tokens are ASCII, so the fold may be restricted to
the characters whose full fold is ASCII-only: A to Z, and eleven others (U+00DF, U+017F, U+1E9E, U+212A, U+FB00 to U+FB06
with U+FB05 and U+FB06 both folding to `st`). That table is derived independently from a second implementation across every
code point, and a test fails if it does not agree. A non-ASCII token added later needs the full fold and a new review.

A match makes the result `null` (row "unavailable" in 5.2). **Under the frozen engine, `null` still holds the drug**
(`sentinel-literal-in-source`). The hand-off's idea that an unavailable result behaves like an absent gene is not adopted
(section 12, R05).

### 5.6 Absence

A gene is **absent** (engine result `gene-absent`) only when **both** hold: the reader's status is `projected` or
`source-abstained`, which means every non-whitespace character was accounted for; and no occurrence of that gene exists in
the result. On a held report no absence is ever asserted, because the reader never saw the whole text. Matching is by exact
upper-case gene symbol against the knowledge set: no aliases, no case folding.

### 5.7 Medication and population context

The adapter carries none. Drugs are chosen by the caller (the engine's `options.drugs`), not read from the report. The
engine evaluates a guideline table purely by gene phenotypes. A published recommendation that depends on something else
(for example, age or ancestry) cannot be represented today. **Until the knowledge schema gains an explicit context field in
its own approved change, no such guideline may be loaded as reviewed content**; this is a curation rule, noted again in
section 11. **[amended]** The hand-off requires explicit, source-bound context (for the saved sertraline integration,
"sertraline" or "general") and holds when it is missing. That requirement is accepted for the slice that adds the context
field; it is not built in this slice, and nothing here manufactures context.

## 6. Report-level holds

A report-level hold produces **no drug results**. It is not expressed with `gene-absent`: evaluating "no genes" would tell a
reader the report lacked genes it may in fact contain. The hold has its own code, fixed message, and reviewer action,
in a list that is separate from the engine's and frozen by a test like the engine's.

| Code | From | Reviewer action |
| --- | --- | --- |
| `capture-not-accepted` | adapter | A person must review the paired PDF and text and accept the capture |
| `capture-hash-mismatch` | adapter | The accepted text is not the text that was read: re-capture and accept again |
| `poppler-version-mismatch` | adapter | Re-capture with the pinned Poppler version |
| `reader-binding-mismatch` | adapter | The reader is not the approved build: stop and investigate |
| `packet-invalid` | adapter | Treat as a defect: the reader's output failed its own integrity checks |
| `evidence-overlap` | adapter | Treat as a defect: evidence for two things overlaps |
| `unsupported-layout` | reader | The report layout is not one of the registered patterns: transcribe by hand or obtain another export |
| `alignment-unsupported` | reader | A column table could not be aligned reliably (for example, a gap collapsed by text capture): transcribe or obtain another export |
| `unsupported-column-layout` | reader | Column layout not supported: same |
| `unaccounted-text` | reader | The report contains text the reader does not recognize (for example a note naming a gene): a person must read it |
| `mixed-frame-set` | reader | Some genes tied to values and some not, in one report: a person must read it |
| `selector-quarantined` | reader | More than one reading was possible and none is permitted: a person must read it |
| `source-limit`, `candidate-or-frame-limit`, `source-time-budget`, `worker-error` | reader | The report exceeded a limit or the reader failed: retry once, then treat as a defect |

Messages never contain text taken from a report.

## 7. Result shape (the index) **[amended]**

```ts
type AdapterResult =
  | { disposition: 'held'; code: ReportHoldCode; message: string; reviewerAction: string; binding: SourceBinding }
  | {
      disposition: 'evaluated';
      geneInputs: GeneInput[];            // exactly what is passed to evaluate(); the only place values from the report appear; each says callSource: 'lab-report'
      occurrences: AdapterOccurrence[];   // the audit trail below
      binding: SourceBinding;
    };

interface AdapterOccurrence {
  gene: string;
  occurrenceIndex: number;                // 0-based per gene, source order, valid for this text hash only
  roles: { diplotype: SpanRef | null; reportedResult: SpanRef | null; emptyRoles: Array<'diplotype' | 'reportedResult'> };
  emitted: Array<{ state: 'canonical' | 'diplotype' | 'null' | 'unresolved'; reasonCode: CallerReasonCode | null }>;  // states and codes only, no values; empty for a repeated gene (its one input is gene-level)
  note: 'corroborated' | 'conflict' | 'result-untrusted' | 'unavailable' | 'empty-field' | 'no-reported-result' | 'nothing-stated'
      | 'abstained' | 'duplicate-identical' | 'duplicate-gene-conflict' | null;
}
interface SpanRef { start: number; end: number; textSha256: string }    // offsets and a hash, never the text
interface SourceBinding { textSha256: string; popplerVersion: string | null; packetHash: string | null; generatorCodeHash: string | null; captureAcceptanceId: string | null }
```

The binding's fields are `null` when a report was held before that fact was known (for example, before the acceptance record
was found). The audit trail's `emitted` carries states and codes but **no diplotype or phenotype text**, so it can be logged and
stored without carrying anything from the report; the values are in `geneInputs`, which is what the engine receives.
Logs and audit records carry offsets, hashes and codes, **never span text**. `clinical_approval` and `training_eligible` stay
`false` on everything derived from the hand-off.

## 8. Expected adapter output for the twelve development cases

Expected inputs below are what a hand-written oracle will assert (before any engine call). They do not depend on any
guideline. `P` is what the engine's mapping says for the diplotype; the corroboration column assumes the case's stated
result matches (D01, D09), which a test also checks with a deliberately wrong result.

| Case | Reader status | Expected adapter output |
| --- | --- | --- |
| D01 two named genes | projected | CYP2C19 `diplotype *1/*2`; CYP2B6 `diplotype *1/*1` (results corroborate) |
| D02 unknown allele | projected | CYP2C19 `diplotype *1/*Z` (engine: `allele-not-in-definitions`; "Indeterminate" is not used) |
| D03 quoted unavailable | projected | CYP2C19 `unresolved / other-gene-unresolved` **[amended]**: the quoted value is not an unavailable token, so it is a non-canonical value |
| D04 result absent | projected | CYP2C19 `unresolved / other-gene-unresolved` **[amended]** (diplotype with no reported result, rule R04) |
| D05 result present, empty | projected | CYP2C19 `null` (empty field) |
| D06 identical repeats | projected | **one** input, CYP2C19 `unresolved / duplicate-identical` **[amended]**; both occurrences stay in the audit trail |
| D07 conflicting repeats | projected | **one** input, CYP2C19 `unresolved / duplicate-gene-conflict` **[amended]** |
| D08 monospaced overflow | held `alignment-unsupported` | report-level hold, no inputs. **Stays held**: the pinned capture loses a column gap, which is the evidence |
| D09 proportional columns | projected | CYP2C19 `diplotype *1/*2`; CYP2B6 `diplotype *1/*1` |
| D10 inline lists | source-abstained | CYP2C19 and CYP2B6 each `unresolved / association-abstained` |
| D11 cross-page result | source-abstained | both genes `unresolved / association-abstained` |
| D12 unregistered narrative | held `unaccounted-text` | report-level hold, no inputs |

The real genes CYP2C19 and CYP2B6 appear only in these labelled TEST ONLY fixtures and in test-only gene maps. They are
never placed in `knowledge/cpic`, and the fixtures are never loaded in production.

## 9. How this will be verified (when code exists)

- Hand-written expected outputs for D01 to D12 above as golden scenarios (independent oracle, not produced by the code under test).
- Every row of 5.2, and every reader status, as its own scenario, plus forged or tampered inputs: wrong hash, wrong Poppler
  version, a rebuilt packet with a different binding, overlapping spans, spans pointing outside the text.
- An exhaustive sweep over (diplotype state × result state × occurrence count) checked against an independent lookup.
- Defect injection: each rule above is broken in turn and a test must fail, with a harmless control.
- Determinism and privacy tests: same inputs give byte-identical results; no span text appears in any output meant for logs.
- A guard that the hand-off fixtures cannot be loaded when the mode is production, and that the vocabulary files are unchanged.

## 10. What this changes and what it does not

| Changes | Does not change |
| --- | --- |
| This document; later, a new adapter module, the reader sidecar and its interface, the imported hand-off files, a capture-acceptance interface | The engine, `GeneInput`, the five outcomes, the 14 reason codes, the knowledge schema, the database, the API |

## 11. Choices for the founder

**Decided 2026-10-08 (the founder approved all recommendations).** The eight choices of the first version stand, except
where section 12 amends them:

1. A held report yields no drug results. *Decided as written.*
2. Strict result handling next to a diplotype. *Decided as written.*
3. The diplotype is the engine input when it agrees with the stated result. *Decided as written; but a diplotype with no result is now unresolved (R04).*
4. An empty field is treated as "no result" (`null`). *Decided as written.*
5. The sentinel set. *Replaced by the seven-token procedure (R06, section 5.5).*
6. Context-dependent guidelines are not loaded until the schema has a context field. *Decided as written; the hand-off's explicit-context rule is accepted for that slice.*
7. Absence is asserted only when the reader accounted for every character. *Decided as written.*
8. The reader's registry stays at CYP2C19 and CYP2B6. *Decided as written.*

## 12. Reconciliation with the second Codex hand-off (2026-10-08)

The hand-off `pgx-claude-handoff-v1` carries design rules the founder approved in the Codex workspace (R02 to R07, and an
amendment to R05). The founder confirmed them as current and as overriding this document where they differ. Nothing in
that package authorizes code, clinical use or training; this table records only how each rule maps here.

| Rule | In the hand-off | Disposition here |
| --- | --- | --- |
| R02 provenance | Disjoint exact gene and value spans with frame and association references; shared headings and empty-field diagnostics preserved | **Already consistent** (section 4) |
| R03=A duplicates | Hold every repeated gene; equality over literal diplotype, literal result, field presence and result basis; compare before absence matching | **Adopted** (section 5.4), with the two duplicate codes added to what an adapter may attach |
| R04 null basis | `null` with `no_reported_result` only for a diplotype and no result field; unresolved downstream; empty or malformed fields hold | **Adopted** (section 5.2). The diplotype-only occurrence is unresolved |
| R06 unavailable matcher | Seven tokens, pinned Unicode 16.0.0 procedure, quotes kept | **Adopted** (section 5.5) |
| R05 lookup precedence (amended) | One canonical gene plus one absent or approved-null gene uses the reviewed single-gene branch; two canonical genes need an in-scope combined-table cell | **Not adopted in this slice.** The frozen engine holds the drug when any gene is absent, unresolved or null, with no fallback to a narrower table. Falling back loosens a hold on clinical output, and the correct behavior depends on the real table structure. It will be decided together with the real sertraline guideline content, with primary-source verification, and would need an explicit guideline-level construct, not a global fallback |
| R07 checker | `Integration.resolve()` only for its saved mappings | **Not applicable.** This adapter feeds the repository's own engine and phenotype mapper; `Integration.resolve()` is not used |
| Occurrence base, `rawText` | Source index is zero-based; a revised schema uses one-based indices and a derived `rawText` | **Not applicable.** These serve the hand-off's own strict consumer. The adapter keeps zero-based per-gene indices |
| Context | Source-bound drug and population context required; missing context holds | **Deferred** (section 5.7) |
| Hold vocabulary | A proposed vocabulary (categories and codes such as `reported-field-empty`, `adapter-policy-unapproved`) still awaiting its owner freeze | **Not adopted.** Section 6 stands until that vocabulary is frozen; an empty result alone still reaches the engine as `null` |

What the reader's authorization does not change: `clinical_approval` and `training_eligible` stay `false`.


## 13. Proposed compatibility contract: R05, explicit context and empty fields

> **Draft for owner review; not implemented or clinical approval.** This section specifies a separate opt-in report lookup boundary. Sections 1–12 describe the existing implementation and earlier decisions; their runtime behavior remains unchanged until a separately approved implementation PR. The proposed direction reconciles the Codex R05/R04/context decisions without globally replacing the engine's table precedence or null semantics. Merging this documentation alone does not enable the boundary, adopt clinical content, authorize training, or establish independent validation.

### 13.1 Placement and compatibility

Reuse the current reader, packet integrity checks, duplicate comparison and phenotype mapper. Run the new boundary after capture/packet/association validation and before guideline selection, using the trusted processing scope and ordered admission gates in 13.7. Do not feed its new objects to existing strict `GeneInput[]`/evaluation consumers. Existing direct `evaluate()` callers and guidelines without an explicit reviewed policy retain their current results. No endpoint, migration, knowledge file or production switch changes in this specification PR.

The repository's zero-based per-gene occurrence indices remain valid. Conversion to the external one-based merged contract is a separate explicit reversible export; no new `rawText` field or second adapter is needed here.

### 13.2 Strict versioned input and evidence

The proposed strict object is `ReportLookupInputV1`: `schema: "report-lookup-input/1"`, `textSha256`, `packetHash`, `captureAcceptanceId`, `policyId`, `policySha256`, `context`, and `geneStates`. Unknown keys fail validation. Hashes are 64 lowercase hex characters; identifiers are nonempty strings of at most 128 characters. The policy's genes are exactly CYP2C19 and CYP2B6 in this first version; one state per gene is required. Drug/population context validation precedes any table routing. Existing structural holds and duplicate/association dispositions remain stronger gates and are not converted into absence.

Evidence references contain `sourceArtifactSha256`, `start`, `end`, and `literalSha256`. Intervals are nonempty half-open Unicode scalar ranges and must reproduce the bound literal hash. Preserve BOM and source bytes. For a context record or value from another artifact, verify that artifact and its review binding; do not compare its offsets against report text. Protected source artifacts may contain literal text; logs and audit envelopes contain hashes/IDs/codes only.

The gene-state tagged union has these exact alternatives:

| State | Required fields besides `gene` and `state` | Admission rule |
| --- | --- | --- |
| `canonical` | `phenotype`, `derivationRecordId` | Phenotype exactly matches the pinned gene list; record binds source evidence, mapping/knowledge version and existing reconciliation gates. Reported Indeterminate is canonical only when permitted by that list; missing/unmappable data cannot manufacture it. |
| `absent` | `coverageRecordId` | Accepted, accounted-for report region and packet prove the gene has no occurrence. Missing value or failed parsing is not gene absence. |
| `approved-unavailable` | `basis: "unavailable-token"`, `valueEvidence`, `matcherPolicySha256`, `reviewRecordId` | Exactly the approved R06 token/procedure; source review and frozen policy authorize its missing-result meaning. Admit only when that occurrence has no diplotype value or present-empty role and passes the ordered checks in 13.7. Record must bind text, packet, occurrence, evidence and policy hashes. Generic old `null` never qualifies. |
| `unresolved` | `reasonCode`, `evidenceRecordId` | Any unmappable, conflicting, malformed, quoted noncanonical or diplotype-only missing-result input remains held under its bound reason. |
| `sentinel` | `valueEvidence`, `evidenceRecordId` | Literal `no result` / `sin resultado`; source quotes remain literal. This is not approved-unavailable. |
| `empty` | `emptyFieldRecordId` | Packet proves a present-empty role. It is neither absent nor approved-unavailable. |

State fields are strict per alternative. Existing gene-symbol and phenotype/value bounds apply; source records must pass the same packet/capture checks and refer to the declared gene. A diplotype with no reported-result field may preserve `no_reported_result` in its evidence record but is `unresolved` here. Repeated genes are held before building this two-state input; do not collapse them into a canonical or missing state. An abstained packet remains association-abstained and never enters this routing boundary.

**Proposed empty-field reason mapping:** any present-empty gene role raises a report-level `reported-field-empty` hold at this new boundary, with no drug results and no selected row. This includes an empty diplotype beside a reported result. The literal empty-field diagnostics remain in the protected evidence record. The frozen repository report-hold vocabulary, fixed privacy-safe message/action and golden expectations must be updated together in the later implementation PR. Existing `null`/sentinel behavior is historical compatibility, not an acceptable conversion for this opt-in path.

### 13.3 Source-bound context

`ContextV1` is a strict object: `schema: "report-lookup-context/1"`, `drug: "sertraline"`, `population: "general"`, `sourceKind: "report" | "reviewed-external"`, `sourceArtifactSha256`, `drugEvidence`, `populationEvidence`, `reviewRecordId`. Both evidence references use section 13.2. A review must attest the drug/population interpretation against that exact artifact and bind the context record; labels inferred solely from fixture scope, caller defaults or omission are invalid. "general" is the reviewed lookup scope, not an asserted patient age or absence of patient-specific contraindications.

A valid context is required even when routing selects no row. Missing, invalid/unreviewed, or changed-source context returns a report-level hold, respectively `lookup-context-required`, `lookup-context-invalid`, or `lookup-context-source-mismatch`. These are proposed new-boundary codes; they do not extend or reinterpret existing frozen codes until a reviewed implementation adopts them. Matching explicit context cannot clear a capture/knowledge/clinical gate.

### 13.4 Guideline-specific routing policy

`SertralineRoutingPolicyV1` is a strict separate artifact: `schema: "sertraline-routing-policy/1"`, `id`, `drug: "sertraline"`, `population: "general"`, `genes: ["CYP2C19", "CYP2B6"]`, `combinedGuidelineId`, `singleGeneGuidelineIds: { CYP2C19: string, CYP2B6: string }`, `reviewedRows`, `knowledgeSetId`, and `reviewRecordId`. Hash and ID bounds follow 13.2. `reviewedRows` is a nonempty array of unique strict selectors `{ guidelineId, table, row, column: string | null }` using each stored recommendation's locator. Every selector must resolve to exactly one verified, non-disputed row in the bound knowledge set; guideline gene sets and drug must match their declared route. No ambiguous locator, absent source row, circular routing or cross-drug policy is permitted.

The review record binds policy bytes, knowledge set and exact primary-source locators. Synthetic policies are test-only and cannot become production knowledge. This document supplies no real recommendation wording or clinical row approvals.

| Gene states, after stronger gates | Routing decision |
| --- | --- |
| Either unresolved, sentinel or empty | Hold; no other-gene fallback. Empty uses 13.2; sentinel uses `sentinel-literal-in-source`; unresolved retains its bound validated reason. |
| One canonical; other absent or approved-unavailable | Only the named single-gene guideline for the canonical gene; require one exact matching in-scope reviewed row. |
| Both canonical | Only the named combined guideline; require one exact matching in-scope reviewed cell. |
| Both absent/approved-unavailable | No row; do not fabricate a phenotype or clinical wording. |

For inputs admitted through the gates in 13.7, the proposed result envelope `ReportLookupDecisionV1` has `schema: "report-lookup-decision/1"`, `inputRecordSha256`, `policySha256`, `contextRecordSha256`, and `decision`. Decision is strict tagged `{ state: "held", reasonCode, selectedRow: null }`, `{ state: "no-row", reasonCode: "both-results-missing", selectedRow: null }`, or `{ state: "row-selected", selectedRow: { guidelineId, table, row, column } }`. A routing decision does not expose recommendation text or mean clinical release.

A missing required source cell or row excluded from the policy returns `out-of-review-scope`, with no narrower route. Existing unverified/disputed cells retain the applicable hold and expose no wording. Missing/invalid/stale routing policy holds as `lookup-policy-invalid`; it must not silently invoke generic fallback. Legacy direct-engine requests without the new boundary keep their old behavior. A verified published "No recommendation" is an actual selected source row and remains distinguishable from `no-row` or an unavailable cell.

New codes in 13.2–13.4 are proposals for the separate boundary. Implementation must review how their categories and fixed messages integrate with report holds and persisted outcomes; do not reuse `sentinel-literal-in-source` for ordinary approved-unavailable tokens or empty values.

### 13.5 Acceptance cases and verification for implementation

1. Both gene orientations of canonical + absent and canonical + approved-unavailable select only the approved single-gene route; both canonical select only the approved combined cell; both missing select no row. Generic old null never passes the approved-unavailable gate.
2. Unknown/malformed, diplotype-only missing-result, quotes, sentinel and empty hold. Empty evidence survives, including empty diplotype and empty result combinations. Duplicate-identical/conflict remains before normalization; association abstention remains separate.
3. Missing, unreviewed, forged or source-changed context/policy/evidence holds. Never default drugs from omitted options or manufacture general population.
4. Out-of-scope/missing cell never falls back; unverified/disputed wording stays hidden. Explicit Indeterminate can match a reviewed source row; no input absence produces Indeterminate.
5. Legacy evaluation callers and guidelines retain their exact expected outputs; source and audit bytes remain unchanged. Development fixture visibility is disclosed; tests do not establish independent clinical accuracy.
6. Before/after gold matrix and exhaustive state sweep with an independent expected oracle. Mutants erase result basis, allow empty as unavailable, enable global fallback, bypass scope/context and expose disputed wording; each must fail. Include harmless controls. If a future persisted schema changes, run real database/storage tiers; mocked pools do not validate migrations.
7. No production, training, model, coordinate or new-gene enablement. Row selection remains behind existing knowledge review and clinical release gates.

These are future acceptance tests, not execution claims. Record storage and endpoint wiring remain separate, but the minimum record validation contracts in 13.7–13.9 are required before implementation. The input/context/policy validators must reject missing evidence rather than treating a placeholder record ID as validation.

### 13.6 Review and supersession

Owner review of this draft must resolve the proposed empty-field report-level code, exact new boundary contracts and integration with stored records before implementation. Approval records for the proposed section must explicitly supersede the section 11 empty-to-null choice and section 12 R05/context deferrals **for the opt-in boundary only**; existing callers remain unchanged. This avoids silently treating two sets of prior founder decisions as interchangeable. Independent prospective PDF validation still requires its human roles, sampling manifests and freezes. Those requirements do not block preparing the bounded synthetic prototype contract.

### 13.7 Ordered admission and validated record references (proposed correction)

**Trusted processing scope:** obtain `tenantId`, `reportId`, `captureId` and actor identity from the authenticated, authorized request and repository transaction; never trust those identities from a lookup payload. All referenced report/capture/evidence/review records are resolved within that tenant. Another tenant's record is not found. Validate referenced capture belongs to the scoped report and that its PDF/object-version/text bindings match the pinned stored artifacts. Global routing/matcher/knowledge artifacts are immutable reviewed artifacts, not tenant identities.

A validated evidence reference is not a declaration supplied by the caller. Minimum record contents and checks:

| Reference | Minimum validated content |
| --- | --- |
| Capture acceptance | ID, tenant/report/capture relation, decision, actor, ordered decision position and bound text/Poppler provenance. Resolve the latest acceptance decision for this capture in the same consistent read as other admission checks; the supplied acceptance ID must equal that current decision and be accepted. Later rejection invalidates admission even if an older accepted ID was supplied. Use the existing records/authorization and separation-of-duties rules. |
| Common source-derived evidence | Record ID/type/version, tenant/report/capture relation, stored text hash, packet hash, pinned reader/build bindings, gene, occurrence index or explicit gene-coverage scope, evidence references and record hash. Verify packet replay/field coverage and exact gene/occurrence membership; reference resolution may not introduce another source gene or repair literals. |
| Derivation record | Common evidence plus reported/diplotype field presence, selected candidate/frame/association references, exact protected source values, pinned gene-definition/function/mapping and knowledge bindings, reconciliation outcome and resulting canonical phenotype. Verify outcome under the existing mapper/adapter admission rules, not merely membership of the phenotype in a vocabulary. |
| Coverage record | Common evidence plus registered region/anchor-policy bindings and accounted-for coverage verdict. Verify no occurrence of the specified gene in the accepted region. An unrecognized region or dropped value cannot establish absence. |
| Empty-field record | Common evidence plus role, present-empty packet diagnostic and exact frame reference. Verify label presence and lack of a value; preserve empty and missing separately. |
| Unavailable review | Common evidence plus result-field/value evidence, matcher-policy hash, routing-policy hash, the token comparison outcome, protected field-state facts, reviewer/decision and review ordering. Bind to the approved-unavailable occurrence and exact artifact hashes; require accepted, current applicable review, not an arbitrary review ID. |
| Context review | Record ID/type/version, tenant/report/capture target, source artifact hash, context-record hash, protected drug/population evidence, reviewer/decision and review ordering. External evidence must be explicitly associated with this scoped report/capture; a review of unrelated evidence cannot supply context. |
| Policy review | Record ID/type/version, exact policy artifact SHA-256, knowledge-set binding, primary-source locators, reviewer/decision and review ordering. A global policy review grants no tenant access. Any applicable tenant dispute overlay must still be honored; a stale knowledge/overlay binding holds. |

Hashes bind exact records/artifacts under 13.9; acceptance and review authority/validity come from trusted stores, not hashes. Records must have a valid current applicable decision; revoked/superseded reviews do not remain valid merely because immutable old bytes exist. Snapshot admission together; before persisting an evaluation, revalidate/serialize the relied-on latest decisions under the existing transaction discipline so concurrent rejection cannot create a newly accepted evaluation from stale admission. Changes after commit do not rewrite historical records: use the correction model for existing evaluations.

**Fixed admission order:** (1) authenticated scope/capture and current acceptance; (2) pinned build, packet integrity and source/field evidence; (3) structural hold or association-abstained disposition; (4) repeated-gene classification; (5) any present-empty role; (6) diplotype/result reconciliation; (7) context, then routing-policy validation; (8) routing. Preserve all discovered additional reasons in protected evidence, with the first failed gate determining the primary disposition. Deterministic evidence/diagnostic ordering follows source occurrence order; do not choose a favorable code by arrival time. Pre-admission association abstention remains its own disposition, not an empty successful lookup.

At gate 6, a present diplotype must be evaluated before unavailable-token admission. Unknown/malformed/unmappable diplotypes remain unresolved even next to an unavailable token. A mappable diplotype plus unavailable or noncanonical result remains unresolved under the existing adapter's reconciliation rule; never ignore the diplotype and route using the other gene. A mappable diplotype with no reported-result field remains unresolved. Only an occurrence with no diplotype value and no empty role can become approved-unavailable after token/evidence review. Canonical phenotype membership alone cannot clear conflicts or unsupported derivation. Gates 5–6 explicitly prevent the unavailable state from bypassing existing adverse source facts.

### 13.8 Early-failure envelope (proposed correction)

The fully bound `ReportLookupDecisionV1` is produced only after input, context and policy admission succeeds. Earlier failures use a separate strict `ReportLookupAdmissionFailureV1` object with fields `schema: "report-lookup-admission-failure/1"`, `stage`, `reasonCode`, `bindings`, and `selectedRow: null`. The stage enum is `capture | packet | association | duplicate | field | reconciliation | context | policy | input`.

`bindings` has exactly `inputRecordSha256`, `textSha256`, `packetHash`, `contextRecordSha256`, `policySha256`, and `captureAcceptanceId`, each nullable. Non-null hashes satisfy the existing 64-lowercase-hex contract. Populate only independently validated available bindings; use null for missing, unreadable, malformed or unvalidated artifacts. No zero hashes, empty strings or hashes of invented placeholder records. Invalid canonical input cannot have an input-record hash. Trusted tenant/report scope stays outside the logging envelope. This envelope is an operational/report hold, not a fabricated clinical drug result.

For this new boundary only, malformed input/evidence references use proposed `lookup-input-invalid`; current acceptance failure uses the existing applicable capture hold; field/context/policy failures retain section 13's applicable reasons. Missing, inaccessible or stale references fail at their fixed admission gate; no generic fallback. Existing source-abstained output is preserved outside this failure envelope. Reason/message mappings must be reviewed with the implementation; error messages never include protected values. Test incomplete input, missing context/policy, stale acceptance and failed source resolution without requiring unavailable hashes or fabricating bindings.

### 13.9 Exact hash basis and conformance (proposed correction)

Use SHA-256 with lowercase hex output. Two contracts are distinct:

- **Artifact bytes:** PDF, stored report text, matcher-policy file, routing-policy file and source artifacts use exact stored bytes, no newline/BOM/whitespace normalization. `sourceArtifactSha256`, literal-slice hashes and the input's `policySha256`/review's policy artifact hash use this basis. A literal hash is SHA-256 of the exact slice encoded as strict UTF-8 after scalar slicing, not UTF-16 offsets. `textSha256` is the stored strict UTF-8 report artifact hash.
- **Logical records:** `inputRecordSha256`, `contextRecordSha256` and common evidence/review record hashes use strict UTF-8 bytes of `canonicalJson(record)` from the repository's restricted canonical JSON contract: null, booleans, safe integers, scalar strings, arrays and plain objects; UTF-16 key ordering; no trailing newline. Reject floats, unsafe integers, duplicate JSON keys before parsing, lone surrogates and unexpected fields. Offsets/indices must be bounded nonnegative safe integers with valid source ranges. Hash the complete validated record payload; any out-of-band stored computed-hash column is excluded, and self-hash fields inside the payload are forbidden. Review IDs are allocated independently, not defined recursively from a record that references that same ID.
- **Existing identities:** packet hash, reader build bindings and knowledgeSetId keep their existing versioned computation rules; do not rehash them as arbitrary artifact bytes or reinterpret their domain. Validate policy bytes first and compare its bound knowledge identity with the actual loaded reviewed set, including applicable overlay semantics.

Raw artifact and logical-record digests are deliberately different types of binding. A policy file formatting change invalidates its artifact review even if its parsed meaning is unchanged; logical-record formatting changes do not change its canonical hash. No claim of general-purpose JCS support beyond the restricted domain.

Before implementation is accepted, independent Python/TypeScript known-answer tests must freeze literal UTF-8/BOM/astral slice digests, exact policy-file digest, and canonical record bytes/digests. Include keys U+E000 and U+1F9EC so UTF-16 ordering differs from scalar ordering, reordered keys, whitespace-only JSON reformatting, and newline changes to policy bytes. Both implementations must reject duplicate keys, floats, unsafe integers and lone surrogates. Existing canonicalizer tests alone do not establish these new record/policy hash contracts.

Add negative cases for cross-tenant/cross-report references, reused context from another capture, accepted-then-rejected capture, review supersession, concurrent rejection before evaluation commit, unavailable next to unknown or mappable diplotype, and each early failure with unavailable bindings. These are specified future tests, not executed claims. Section 13 remains draft for owner review; no runtime, clinical or training permission changes.
