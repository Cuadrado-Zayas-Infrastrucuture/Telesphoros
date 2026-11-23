# Genomic profile: "Record a decision", the signed-knowledge label and browser tests (spec 044 slice B part 2b)

Date: 2026-11-23

This is the second and last pull request of slice B part 2.

- **"Record a decision".** Under each result's evidence, it links to that result in the patient's results list (`?result=`), where the
  existing decision form is (B2-D4). The results list reads again when the link changes, so the result opens. On the synthetic staging it
  is a disabled button, with "Decisions are not switched on in this environment." beside it.
- **The signed-knowledge label.** Each profile result now carries its evaluation's stored `scope`, an optional field (B2-D5). A row with a
  result made with the signed, real knowledge shows K2c's label once.
- **Browser tests.** `e2e/genomic-profile.spec.ts` checks the section at 375 and 1280 px, light and dark:
  - no sideways scroll;
  - axe, colour contrast included;
  - 44 px targets and heading order;
  - keyboard use;
  - the decision link.

  The glossary words now carry vertical padding, so they are 44 px targets.

No route, role, migration, setting or knowledge change, and decisions stay off on staging.
