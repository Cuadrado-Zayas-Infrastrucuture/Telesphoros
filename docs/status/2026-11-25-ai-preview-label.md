# The local-only "Chat preview" entry is called "AI preview"

Date: 2026-11-25

The founder chose this on 2026-11-25. In local builds only, the sidebar offered **Chat preview** for `/local-interpretation`, a design preview
of an interpretation assistant, while the header names the same page **AI preview**. With the chat retired (spec 052), "Chat preview"
read as if the chat were still there.

- `SIDEBAR_WORDS.chatPreview` is now `aiPreview`, "AI preview", and the sidebar's fixed panel name follows.
- Its Spanish row in `docs/design/spanish/ls2-shell.md` is renamed to match and stays empty for the founders (LS2b).
- Tests that name the link: `WorkspaceSidebar.test.tsx`, `ReportsPage.test.tsx`, and the local-e2e `sidebar-workspace` and
  `report-workspace` specs.

Not changed: the preview page's own heading, "Chat workspace" (`SyntheticAssistant.tsx`, asserted in three tests). It is a
separate question, named in the PR. Staging and hosted builds never show the entry.
