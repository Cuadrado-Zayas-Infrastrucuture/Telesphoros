# "Not tested" on the gene card opens its glossary entry (spec 044)

Date: 2026-11-26

The founder chose this on 2026-11-26, after #498 added the draft glossary entry `not-tested`. "Not tested" on a gene card, and in a
medication's evidence for a gene no confirmed report includes, now opens that entry in the glossary drawer. It is the same `GlossaryTerm`
button that Poor Metabolizer, Held and the other words use, with the same draft line, focus and return. No new words and no change to the
text on screen.

Test: `GenomicProfileSection.test.tsx` opens "Not tested" on the GENEC card, sees the entry's text in the drawer, closes it, and finds the
focus back on the word. The existing case that reads "Not tested" on the card still passes as written, since the text is inside the
button. CPIC stays plain text: it sits inside the profile's intro sentence. No Spanish, route or API change.
