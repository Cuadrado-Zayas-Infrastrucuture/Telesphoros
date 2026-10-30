# Feature Specification: Polish the one-screen workspace (WP)

**Feature Branch**: `feat/workspace-polish`

**Created**: 2026-10-30

**Status**: Approved 2026-10-30 ("Yes, remove letters").

**Input**: The founder asked to polish the workspace for the staging prototype. A walkthrough of `/local-workspace` on `main` (empty, report attached, question asked, phone width) found one bug and six rough edges. The public landing now leads with pharmacogenomic report interpretation and says plainly that the prototype does not interpret reports yet; the workspace should say the same.

## Decisions

- **D1, scope:** the local preview's workspace only (specs/016, 021, 022). Production, the sample engine's answers, upload rules, the reports pages and the backend are unchanged.
- **D2, the input bar on a phone:** the bar that stays at the bottom (sample questions and input) takes at most a third of a phone screen, and the end of an answer can always be scrolled clear of it.
- **D3, empty-state heading:** "Start with a synthetic report." The old "Which report should we read?" promised a reading the prototype does not do.
- **D4, sample questions:** shown with short labels that fit one line ("Explain this", "Missing evidence", "Limitations"); they still ask the full questions the sample engine knows. After an answer they sit in one row.
- **D5, attached report:** the file, its remove button and its patient sit on clean lines; the patient picker shows its whole choice; the confirmation reads "I confirm this file contains synthetic data only", as on the Upload page.
- **D6, feedback:** "Was this answer helpful?" (was "Was this layout helpful?").
- **D7, background (founder's decision):** the faint A/C/G/T letters are removed; the two folds stay.
- **D8, notice:** "Synthetic data only. Not for clinical use." sits right under the input instead of at the foot of the window.

## Out of scope

- The sample answers' wording, the chat preview at `/local-interpretation`, the mascot, colors, production builds.

## Requirements

- **WP-1** At 390 px, after an answer, scrolling to the end shows the sample-answer note and the feedback buttons uncovered; the bottom bar is at most a third of the screen tall.
- **WP-2** The empty workspace's heading reads "Start with a synthetic report." and no A/C/G/T letters are drawn.
- **WP-3** With a file attached at desktop width, the remove button sits on the file's line, the patient picker is not cut off, and the checkbox is named with the full confirmation sentence.
- **WP-4** The feedback line asks "Was this answer helpful?".
- **WP-5** Each sample question fits one line on desktop and asks the same question as before.
- **WP-6** The synthetic notice sits within 120 px below the input on the empty screen.
- **WP-7** axe finds no WCAG 2.1 A/AA violations in light or dark; nothing scrolls sideways at 390, 768 or 1280 px.
