# Spanish in the signed-in app: the LS2 plan (spec 050)

Date: 2026-11-25

A plan, `specs/050-workspace-spanish/plan-slice-ls2.md`, for the first translated screens: the shell (sidebar, account menu, header,
footer, consent bar) and the sign-in pages. That is about 55 strings. It is split in two:

- **LS2a**, English only:
  - the strings move into word tables;
  - one source for the header and footer shared with the landing;
  - a preview for the founders, in development and e2e builds only;
  - a list of every string for the founders to fill in.
- **LS2b:** the founders' signed Spanish.

Nobody can choose Spanish until LS6. Six decisions, LS2-D1 to LS2-D6, were put to the founder, who approved all six as recommended on 2026-11-25. Among them: how the founders preview their
text, and whether they review the landing's existing draft Spanish rather than write it again. No code change.

Also in this pull request: a fix to LS1 (#470). `AppFrame` now sets `<html lang>` in a layout effect, in the same commit as the content, and the
two tests that read it wait for it. A test had read the attribute before the effect ran, and failed on timing.
