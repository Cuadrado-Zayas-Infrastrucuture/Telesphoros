---
name: telesphoros-domain-modeling
description: Sharpen Telesphoros domain language. Resolve ambiguous or conflicting terminology into one canonical term, maintain the glossary of definitions, and record hard-to-reverse architecture decisions as ADRs in docs/adr. Use when a term is fuzzy, names disagree between code and docs, a glossary entry or meaning must be settled, or a decision needs an ADR.
---

# Model the Telesphoros domain

Use the [repository context](../../references/telesphoros.md). This is the active discipline of changing the shared language. Reading the glossary for vocabulary is a habit every workflow has; it does not need this skill.

## Where the model lives

- **Glossary:** `docs/glossary.md`, one context for the whole repository. Create it lazily, when the first term is resolved. Use the [glossary format](GLOSSARY-FORMAT.md).
- **Decisions:** `docs/adr/NNNN-slug.md`. [ADR 0001](../../../docs/adr/0001-repository-layout.md) is the first; scan the folder for the next number at write time. Use the [ADR format](ADR-FORMAT.md).

## During the session

1. **Challenge against the glossary.** When a term conflicts with `docs/glossary.md`, say so at once: "The glossary defines a correction as X; you seem to mean Y. Which is it?"
2. **Sharpen fuzzy language.** For a vague or overloaded word, propose one canonical term and list the others under _Avoid_.
3. **Test with concrete scenarios.** Invent edge cases that force a boundary to be stated: a second organization, a superseded report, a withdrawn correction, a user with two roles.
4. **Cross-check the code.** When someone states how something works, read the code and its tests. Surface a contradiction with the file and line instead of choosing silently.
5. **Write resolved terms down as they settle,** not in a batch at the end. A glossary entry says what a thing is; it holds no implementation detail, plan or status.
6. **Offer an ADR sparingly:** only when the decision is hard to reverse, surprising without context, and the result of a real trade-off. If any of the three is missing, skip it.

## Boundaries

- **Product terms first.** The glossary starts with product and engineering language (report, correction, organization, membership, upload). Clinical terms (genotype, diplotype, phenotype, a drug recommendation) are proposed only, marked `needs founder review`, and never written as settled: the founder reviews them as pharmacist.
- The glossary never restates clinical content. `knowledge/`, `docs/clinical-validation/` and signed guideline text are out of scope for this skill.
- Synthetic examples only. No patient, provider or tenant data in a term, a scenario or an ADR.
- An ADR records a decision someone with authority made. Do not write one to settle an open question, and do not mark it accepted without the founder's approval.
- Glossary and ADR changes go in their own pull request, off main, like any other change.

**Return:** the terms resolved (canonical, _Avoid_), the contradictions found with file references, any ADR proposed or written, and the open questions, with clinical terms listed separately.

**Self-check:** Is every definition free of implementation detail? Did a code claim come from reading the code? Is any clinical term written as settled? Does each ADR meet all three tests?
