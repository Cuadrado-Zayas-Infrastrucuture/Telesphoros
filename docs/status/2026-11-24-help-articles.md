# The help assistant, H1: the articles (spec 051)

Date: 2026-11-24

`packages/help-content` now holds the help panel's content beside the glossary:

- **`help.en.json`** has thirteen draft English articles and the refusal sentence, the one shown instead of any search when a question is
  about a patient. The articles cover:
  - what Help answers;
  - the worklist, held results and follow-ups;
  - finding or adding a patient, and attaching a report;
  - the genomic profile and the phenoconversion notice;
  - recording a decision;
  - roles, synthetic data only, and the words used on the screens;
  - where the policies are, which says they are not yet published (H-D2).
- **`help.es.json`** is empty until the founders write the Spanish (H-D1, spec 050).

The schema, in `help.ts`:

- Each article is plain paragraphs, names its screens and roles, and links only to app screens without a parameter.
- An article or the refusal sentence is `draft` until two pharmacists sign it, the glossary's rule.
- No id is used twice, and every Spanish article must have an English twin.

The tests also check that no article reassures: none says "safe", "no interaction", "not affected" or "none".

Nothing reads the articles yet: the panel is H2. Package only: no frontend, backend, route, setting or migration change.
