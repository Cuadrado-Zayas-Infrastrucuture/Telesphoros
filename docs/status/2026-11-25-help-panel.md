# The help assistant, H2: the panel (spec 051)

Date: 2026-11-25

Every signed-in page now has **Help** in the sidebar (H-D4). It opens the side drawer:

- **The articles for this page and these roles.** A reader on the worklist is not offered follow-ups or attaching a report.
- **Search as you type,** over every article and every glossary word, with no model (section 4). The score is 2 for a title or keyword
  word and 1 for a body word. Results are ordered by score, then by this page's own articles, then by title. When the best match covers
  fewer than half the question's words, the panel says "No article answers that exactly. These are the closest:" and shows three.
- **An article,** with its paragraphs, its links to app screens and its draft line: "Draft: not yet reviewed by a pharmacist."

A question about a patient is refused before any search (section 5, H-D6), with the signed-to-be sentence from `packages/help-content`. On a
patient's page, the panel adds a link to that patient's results. The question counts as about a patient when it has:

- a synthetic patient label;
- a star allele;
- an activity score with a number;
- a word for a person beside a word that asks what to do clinically, in English or Spanish.

The rule is tested against a list of questions that must be refused and a list that must still be answered. One signal from the spec is
not in this slice: a drug name from the bundled list, together with a patient word. "Can my patient take clopidogrel" is already caught by
the patient word and "take". Loading the 2.6 MB drug list into the sidebar for this would cost more than it adds.

The panel's code loads the first time Help is opened, so the sidebar stays small. It renders into the page's body, because on a phone the
sidebar is a menu that hides itself. It reads only the bundled articles, the page's address and the roles. Nothing typed is sent or stored,
and a unit test and a browser test both hold that.

Tests: `lib/helpSearch.test.ts`, `components/help/HelpPanel.test.tsx` and `e2e/help-panel.spec.ts` (375 and 1280 px, light and dark,
keyboard, 44 px targets, axe). Frontend only: no backend, route, setting or migration change.
