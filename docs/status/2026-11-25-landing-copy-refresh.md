# The landing page says what the app is now (landing copy refresh)

Date: 2026-11-25

Built from `docs/design/plans/landing-copy-refresh.md` (#484), approved on 2026-11-25: LC-D1 and LC-D2 as recommended, LC-D3 the English first.

- **The English describes the app as it is:** the worklist home, the Patients page with its search, Attach a report, the Reports page,
  Recents in the sidebar, and Help. The third feature row is now "Start from your worklist."
- **The decorative exchange is a Help question about using the app** (LC-D2): "How do I attach a report?" / "Choose Attach a report on
  your home page."
- **The last question is about Help:** "Does Help answer questions about a patient?" No: it explains the app, and a question about a
  patient gets a fixed sentence pointing to that patient's results.
- **The hero's "Upload a synthetic report" opens Attach a report** for a writer role (spec 052 RC-2). It used to open the home, where
  the chat attached reports.
- **Unchanged:** every boundary statement, and "Clinical interpretation and prescribing recommendations are not available yet." (LC-D1).
- **Spanish (LC-D3):** the seven Spanish rows that still describe the chat are left as they are, each marked in `landing-copy.ts` for the
  founders' rewrite. Until then the Spanish page describes the chat.

No other page, word table or test changes; no backend, API, migration or Terraform change.
