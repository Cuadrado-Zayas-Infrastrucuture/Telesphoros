# The genomic profile screen, first part (spec 044 slice B)

Date: 2026-11-21

The patient page now opens, under the banner and for clinical readers, the genomic profile and medication check of
`specs/044-genomic-profile-medication-check/plan-slice-b.md`. In order (B-D1):

- one summary line that counts only guidance to review;
- the notice for reports waiting on their patient link;
- each current medication with its word and the sentence it carries, CPIC's recommendation quoted with its strength and the gene it rests
  on, and "Why, and the evidence" opening the implication and the evidence;
- a drug checked before prescribing by ingredient or brand name, which saves nothing;
- one card per gene, with "Not tested" for a gene a guideline needs that no confirmed report includes.

"Guidelines changed", "Two reports disagree", the combination-product sentence (B-D2) and the capped notice appear on the row or the
section. A 503 or a failed read answers in place, and the rest of the page keeps working. Every fixed string is in
`apps/frontend/src/lib/genomicProfileWords.ts`: **draft wording, awaiting G3**, English only.

Not in this part:

- the glossary, whose entries the founders write and sign (B-D4);
- the disabled "Record a decision" control;
- K2c's signed-knowledge label, because the profile response carries no evaluation scope (an API addition);
- the 390 and 1280 px browser tests;
- the Spanish strings.

The capped sentence names no count, because the response gives only `capped: true`. No route, schema, setting or backend change.
