# Plan: spec 045, slice N4, a drug being considered that would change a gene's effect

**Status**: **approved by the founder on 2026-11-24: N4-D1 and N4-D2 as recommended.** N4-D3, the wording, stays with P-D6: the code carries the draft text marked as awaiting the founders' signature. Read against `main` after PR #450, which completed spec 044 slice B.
This is the slice the founder set aside on 2026-11-21 as N2-D1: "a later slice, with its own wording".

## The problem it solves

Slices N2 and N3 answer this question: does a medication this patient **already takes** change a gene that a row's guidance rests on?
They do not answer the question a prescriber asks at the moment of prescribing.

> I am about to start fluvoxamine. Does it change a gene that the guidance for this patient's **current** medications rests on?

Example: a patient takes clopidogrel, and its guidance rests on CYP2C19. A strong CYP2C19 inhibitor started next to it makes the
CYP2C19-based guidance for clopidogrel describe a body that is no longer there. Today, "Check a drug before prescribing" shows only the new
drug's own guidance.

## What N4 does, and does not do

**Does:** when a drug checked before prescribing (`?rxcui=`) is listed in a signed gene modifier list against gene G, the check says so:

- it names the current, active medications whose matching results rest on G;
- it names the checked drug itself, if its own matching results rest on G.

The source is one step away, as in N3.

**Does not:** compute an adjusted phenotype, change a word or a recommendation, hold anything, or write anything. It says nothing about a
drug that is not listed. It is still step 1 of spec 045: a factual notice only.

## The response (addition only, optional)

```
GenomicCheck += { candidateNotices?: [CandidateNotice] }    // only on the ?rxcui= check, never on a current medication's row
CandidateNotice = {
  kind: "candidate-modifier",
  gene,                                             // e.g. CYP2C19
  effect: "inhibitor" | "inducer", strength: "strong" | "moderate",
  affected: [{ rxcui, name, self: boolean }],       // current medications whose matching results used gene; self = the checked drug
  source: { listId, source, sourceVersion, sourceUrl, table, row | null }
}
```

As in N2, the server returns facts, not sentences. The field is optional, the response is still parsed strictly, and the backend and
frontend ship in one pull request.

## Rules (the builder, a pure function, unit-tested)

1. **Only the check.** `candidateNotices` appears only on `profile.check`, the drug being considered. It never appears on a current
   medication's row, which N2 already covers.
2. **A notice per listed gene.** For each modifier entry for the checked RxCUI (exact id, PN-3), against gene G, one notice. `affected`
   lists the following, in name order, then RxCUI order:
   - every current, active medication (the same set as N2 rule 1) with a matching result that used G;
   - the checked drug itself (`self: true`) if its own matching results used G.
3. **Nothing affected, no notice (N4-D1).** A notice whose `affected` would be empty is left out.
4. **A current medication with no matching result is never "affected".** `no-guideline-loaded` rows have no genes (as N2 rule 3).
5. **Combination products are not split** (spec 039 D2): a `MIN` checked drug is a modifier only if the list names its own id, which an
   `IN`-only list never does.
6. **With no list loaded,** no `candidateNotices` anywhere, as N2 rule 7 and PN-6.
7. **Nothing else changes** (PN-4): with `candidateNotices` removed, the response is identical to today's.
8. **Not for a drug already taken.** A checked drug that is already one of the patient's current, active medications gets no candidate
   notice: "Starting this medication" would be wrong, and its effect is already N2's notice on the rows.

## The words (draft; the founders' to approve and sign, P-D6)

On the checked drug's row, after its own guidance and any N3 notice. Always shown, in the amber of notices:

| Case | Draft text |
| --- | --- |
| The bold line | **Starting this medication can change other guidance.** |
| An inhibitor, current medications affected | "Fluvoxamine strongly lowers CYP2C19 activity. The guidance for clopidogrel, which this patient takes, is based on CYP2C19 and does not take this into account." |
| Several affected | "… The guidance for clopidogrel and omeprazole, which this patient takes, is based on CYP2C19 …" |
| An inducer, moderate | "moderately raises" |
| The checked drug's own guidance rests on G | "Its own guidance above is based on CYP2C19 as well, and does not take this into account either." |
| The evidence (opened) | As in N3: "Fluvoxamine: listed as a strong inhibitor of CYP2C19." "Source: [list], version [v], [table], row [r]." and the link |

The drug names above only illustrate the sentences. What the screen names comes from the signed list (N0). "Phenoconversion" links to its
glossary entry, as in N3.

## Decisions for the founders

- **N4-D1. Show the notice only when something this patient takes is affected.**
  - **Decided 2026-11-24: yes.** A notice should matter to this patient, as N2 keeps to "only what the result rests on".
  - **The alternative:** always say "Fluvoxamine strongly lowers CYP2C19 activity", even when nothing current rests on CYP2C19.
- **N4-D2. Rows of the current medications.**
  - **Decided 2026-11-24: no change to them.** The notice lives on the check, where the prescriber is looking. The affected medications are
    named there in words.
  - **The alternative:** also mark each affected row while a drug is being checked.
- **N4-D3. Wording.** The table above, and the Spanish later (P-D6).

## Touched

| Path | Change |
| --- | --- |
| `packages/shared-types/src/genomic-profile.ts` | `candidateNoticeSchema`; optional `candidateNotices` on `genomicCheckSchema` |
| `apps/backend/src/genomic-profile/genomic-profile.builder.ts` and its spec | Rules 1 to 7 |
| `apps/backend/test/genomic-profile.e2e-spec.ts` | A `?rxcui=` check of a listed drug, with a current medication whose result rests on the gene (memory and PostgreSQL with S3) |
| `apps/frontend/src/lib/genomicProfileWords.ts` | The words above (draft) |
| `apps/frontend/src/components/patients/` | A `GenomicCandidateNotices` component, and its evidence under the opened layers (one component per file) |
| `GenomicProfileSection.test.tsx` | Unit tests below |
| `docs/clinical-validation/genomic-profile-read.md`, one status fragment | The claims and their tests |

## Not touched

- No route, role, migration or setting change. No knowledge file, because the lists are N0's.
- No adjusted phenotype (spec 045 step 2).
- On staging no list is loaded, so the check shows no candidate notice, and the line from N3 already says "not checked yet".

## Tests (working agreement 6)

- **Builder:**
  - a listed checked drug with a current medication resting on its gene gives one notice naming that medication;
  - several affected medications appear in order;
  - `self: true` when the checked drug's own result rests on the gene;
  - an empty `affected` gives no notice (N4-D1);
  - a stopped medication, a `no-guideline-loaded` row and another gene give nothing;
  - an exact RxCUI only;
  - no list loaded gives none;
  - PN-4: identical with the field removed.
- **Screen:** the bold line and the sentence for one and for several affected medications, inhibitor and inducer, strong and moderate; the
  `self` sentence; the evidence when opened; no "safe", "no interaction", "not affected" or "none" anywhere.
- **e2e (API):** the route carries the notice for a signed synthetic list and writes nothing.
- Each rule is broken in turn and a test must fail. This is run where tests can run, as for N2 and N3.

## How it will be verified

As before, the code is written here and **not run here** (founder decision P2), and CI is the first run.
