# Spanish in the signed-in app: the LS1 plan (spec 050)

Date: 2026-11-24

A plan, `specs/050-workspace-spanish/plan-slice-ls1.md`, for the language layer every later Spanish slice uses. It covers:

- the app's own language choice, English by default, stored only with consent;
- word tables whose Spanish cannot miss a key;
- screens named by their route, untranslated by default;
- one owner of `<html lang>`;
- dates bound to a translated screen's language;
- `IDENTITY_WORDS` moved to the new form;
- a pull-request line on Spanish.

It writes no Spanish, and nothing changes on screen. The account menu still says "Español: aún no disponible". Five decisions, LS1-D1 to
LS1-D5, were put to the founder, who approved all five as recommended on 2026-11-25. No code change.
