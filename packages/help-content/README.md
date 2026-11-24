# help-content

Reviewed help content that the screens and the help assistant share, so they cannot say different things (spec 044 slice B part 2,
decisions B-D4 and B2-D1). **Synthetic data only.** It is general education, the same for every patient and never about one patient.

- `src/glossary.en.json`: the glossary. Each entry is `draft` until two pharmacists have reviewed it. Then its `status` becomes `signed` and
  `signedBy` names both of them, with the date. This is a recorded sign-off, not a cryptographic signature. The screen shows on each entry
  who signed it, or "Draft: not yet reviewed by a pharmacist."
- `src/glossary.ts`: the schema. A file that breaks a rule is refused when it is loaded.
  - A signed entry names at least two pharmacists, and a draft names nobody.
  - No id is used twice, and no alias belongs to two entries.
  - No field the schema does not know is allowed.
- `glossaryEntryFor(text)`: the entry whose alias is exactly that screen string, ignoring letter case and repeated spaces. Nothing is
  guessed.

To change an entry, edit its `body` and `aliases`. When two pharmacists have reviewed it, set `status` to `signed` and add both to
`signedBy`. `pnpm --filter @telesphoros/help-content test` holds the rules. The frontend reads this package from source, with no build
step. The Spanish file (`glossary.es.json`) waits for the founders' text.
