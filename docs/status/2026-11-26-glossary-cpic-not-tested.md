# The glossary explains CPIC and "Not tested" (spec 044)

Date: 2026-11-26

The founder chose this on 2026-11-26. The screens say "CPIC" throughout (for example "CPIC wording is quoted exactly") and a gene card can
say "Not tested", but the glossary explained neither, so a reader without a pharmacogenomics background had nowhere to look.

Two new draft entries:

- `cpic`, aliases "CPIC" and "Clinical Pharmacogenetics Implementation Consortium". It is the first entry, because the others rest on it:
  > The Clinical Pharmacogenetics Implementation Consortium: experts who publish peer-reviewed guidelines on using genetic test results
  > when prescribing some medications. The guidance in this app quotes CPIC's own wording.
- `not-tested`:
  > A guideline for one of this patient's medications uses this gene, but no confirmed report for this patient includes a result for it.
  > It does not mean the gene is normal.

Both appear in the glossary drawer ("Words used here") and in Help search. Neither becomes a button on the page: the gene card shows "Not
tested" as plain text and no screen wraps "CPIC". Making them buttons would be a screen change for its own slice. Both are drafts until
two pharmacists sign them.

`glossary.test.ts` lists both ids. The existing "never reassures", "plain text", "draft until signed" and drawer cases cover them. No
Spanish, screen, route or API change.
