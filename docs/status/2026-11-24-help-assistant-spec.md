# Spec 051: the help assistant, curated (direction plan slice A3; specification only)

Date: 2026-11-24

A draft specification, [spec 051](../../specs/051-help-assistant/spec.md), for the product's help with no model:

- **A Help panel** in the side drawer, from every signed-in page.
- **Articles for the screen and role in view,** written as reviewed content in `packages/help-content` beside the glossary.
- **Search as you type,** fixed and tested. A weak match says so, and never guesses.
- **A deterministic rule for patient questions:** a question about a patient is refused before any search, with a fixed sentence and a
  link to the patient's page.

The panel reads no patient data and sends or stores nothing typed. It comes in three slices:

- **H1:** the articles.
- **H2:** the panel.
- **H3:** topic counts, later if H-D3 says so.

Six decisions, H-D1 to H-D6, wait on the founder. H-D1 and H-D2 are the direction plan's F2 and F3. No code, route, setting, migration or
knowledge change.
