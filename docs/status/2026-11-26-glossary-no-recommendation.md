# The glossary explains "No recommendation" (spec 044)

Date: 2026-11-26

The founder chose this on 2026-11-26. The glossary explained three of the four words a medication row can show (Guidance to review, Held,
No guideline loaded) but not **No recommendation**, which plan-slice-b section 6 left out of its first terms. The Help article
"Checking a drug before prescribing" (#492) says each word has a short explanation, which was not true for this one.

One new draft entry, `no-recommendation`:

> The loaded guideline covers this medication and this genetic result, but publishes no recommendation for it. The row gives the
> guideline's own reason. It does not mean the genetic result has no effect.

The word on a row becomes a glossary button, as the other three are (`GlossaryTerm`), and it is listed in the glossary drawer. It is a draft
until two pharmacists sign it; the founders reword it as they see fit. `glossary.test.ts` lists the id. The existing "never reassures",
"plain text" and "draft until signed" cases cover it, and so does the drawer test that lists every term.

No Spanish, screen, route or API change.
