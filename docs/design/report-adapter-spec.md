# Report adapter specification

> **Status: proposed for founder review. No adapter, reader or import code exists yet, and none will be written until this
> document is approved.** It is the first deliverable of slice 5B-2a. Open choices are collected in section 11, each with a
> recommendation; approving this PR as written accepts the recommendations.

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
  folding, no synonyms: the same rule the engine applies). It is a **sentinel** when it is exactly one of the
  closed set in section 5.5. Otherwise it is **non-canonical**.

### 5.2 One occurrence to engine input

`mapPhenotype` below means the engine's own diplotype mapping for that gene; the adapter never maps alleles itself.

| Diplotype | Reported result | Emitted input(s) for the occurrence | Why |
| --- | --- | --- | --- |
| present, **cannot** be mapped (malformed, unknown allele, no mapping, no gene definition) | anything | `diplotype` | The engine then reports its own precise reason (`malformed-diplotype`, `allele-not-in-definitions`, `no-phenotype-mapping`, `no-gene-definition`) |
| present, maps to phenotype P | missing | `diplotype` | A diplotype is enough |
| present, maps to P | canonical and equal to P | `diplotype` | The stated result corroborates it |
| present, maps to P | canonical and **different** from P | **two** inputs: `diplotype` and `canonical` | They differ, so the engine's duplicate rule holds the gene as `duplicate-gene-conflict` |
| present, maps to P | non-canonical, sentinel, or empty | `unresolved` with `other-gene-unresolved` | The report says something about the result that cannot be checked against the diplotype, so it is not trusted |
| missing | canonical | `canonical` | |
| missing | sentinel | `null` | Report says "no result": engine reports `sentinel-literal-in-source` |
| missing | **empty** | `null` | A declared field with nothing in it is a "no result" |
| missing | non-canonical | `unresolved` with `other-gene-unresolved` | Unfamiliar wording: ask the lab |
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

### 5.4 Duplicates: when two occurrences are "equal"

Equality is decided by the engine on the **emitted inputs** (state plus value), never on spans, offsets, pages or the
literal text of a corroborating result. Identical emitted inputs give `duplicate-identical`, anything else gives
`duplicate-gene-conflict`; both are held (approved default, section 5.1 of the 5B-1 vocabulary). The adapter therefore
only has to emit one input per occurrence in the same form for the same content, and the engine does the rest.

### 5.5 Sentinel literals

A closed set, frozen in code and in this document. Initial member, from the hand-off fixtures: `"not available"`
(including its quotation marks, as in D03). Adding a member is a reviewed change that names the report type it comes
from. Anything else that is not canonical is `non-canonical`, not a sentinel.

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
section 11.

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

## 7. Result shape (the index)

```ts
type AdapterResult =
  | { disposition: 'held'; code: ReportHoldCode; binding: SourceBinding }
  | {
      disposition: 'evaluated';
      geneInputs: GeneInput[];            // exactly what is passed to evaluate()
      occurrences: AdapterOccurrence[];   // the audit trail below
      binding: SourceBinding;
    };

interface AdapterOccurrence {
  gene: string;
  occurrenceIndex: number;                // 0-based per gene, source order, valid for this text hash only
  roles: { diplotype: SpanRef | null; reportedResult: SpanRef | null; emptyRoles: Array<'diplotype' | 'reportedResult'> };
  emitted: GeneInput[];                   // one, or two for a diplotype/result conflict
  note: 'corroborated' | 'result-ignored-missing' | 'conflict' | 'result-untrusted' | 'sentinel' | 'empty-field' | 'nothing-stated' | 'abstained' | null;
}
interface SpanRef { start: number; end: number; textSha256: string }    // offsets and a hash, never the text
interface SourceBinding { textSha256: string; popplerVersion: string; packetHash: string; generatorCodeHash: string; captureAcceptanceId: string }
```

Logs and audit records carry offsets, hashes and codes, **never span text**, so a future real report cannot reach a log.
`clinical_approval` and `training_eligible` stay `false` on everything derived from the hand-off.

## 8. Expected adapter output for the twelve development cases

Expected inputs below are what a hand-written oracle will assert (before any engine call). They do not depend on any
guideline. `P` is what the engine's mapping says for the diplotype; the corroboration column assumes the case's stated
result matches (D01, D06, D07, D09), which a test also checks with a deliberately wrong result.

| Case | Reader status | Expected adapter output |
| --- | --- | --- |
| D01 two named genes | projected | CYP2C19 `diplotype *1/*2`; CYP2B6 `diplotype *1/*1` (results corroborate) |
| D02 unknown allele | projected | CYP2C19 `diplotype *1/*Z` (engine: `allele-not-in-definitions`; "Indeterminate" is not used) |
| D03 quoted unavailable | projected | CYP2C19 `null` (engine: `sentinel-literal-in-source`) |
| D04 result absent | projected | CYP2C19 `diplotype *1/*2` |
| D05 result present, empty | projected | CYP2C19 `null` (empty field) |
| D06 identical repeats | projected | two identical `diplotype *1/*2` inputs (engine: `duplicate-identical`) |
| D07 conflicting repeats | projected | `diplotype *1/*2` and `diplotype *2/*2` (engine: `duplicate-gene-conflict`) |
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

## 11. Choices for the founder (recommendations are what this document assumes)

1. **A held report yields no drug results** (instead of calling the engine with no genes, which would read as `gene-absent`). *Recommended: as written.*
2. **Strict result handling:** when a diplotype is present, a result that is non-canonical, a sentinel, or empty is not trusted and the gene is held (`other-gene-unresolved`); a canonical result that disagrees is held as a conflict. *Alternative:* ignore a non-canonical result next to a usable diplotype. *Recommended: strict;* a lab wording we do not recognize beside a genotype is exactly where silent errors hide.
3. **Diplotype is the engine input when it agrees with the stated result,** so CPIC's tables, not the lab's wording, decide the phenotype. *Recommended: as written.*
4. **An empty field is treated as "no result"** (`null`), not as missing. *Recommended: as written.*
5. **Sentinel set starts as `"not available"` only** and grows by reviewed change. *Recommended: as written.*
6. **Context-dependent guidelines are not loaded** until the knowledge schema gets an explicit context field, in its own approved PR. *Recommended: as written; it needs a later slice.*
7. **Absence is asserted only when the reader accounted for every character** of the report. *Recommended: as written.*
8. **The reader's registry stays at CYP2C19 and CYP2B6** until a reviewed change extends it; a report mentioning other genes is held, not partly read. *Recommended: as written.*
