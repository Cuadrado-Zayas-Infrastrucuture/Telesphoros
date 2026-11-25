# The local-only "Chat preview" entry is called "AI preview"

Date: 2026-11-25

The founder chose this on 2026-11-25. In local builds only, the sidebar offered **Chat preview** for `/local-interpretation`, a design preview
of an interpretation assistant, while the header names the same page **AI preview**. With the chat retired (spec 052), "Chat preview"
read as if the chat were still there.

- `SIDEBAR_WORDS.chatPreview` is now `aiPreview`, "AI preview", and the sidebar's fixed panel name follows.
- Its Spanish row in `docs/design/spanish/ls2-shell.md` is renamed to match and stays empty for the founders (LS2b).
- Tests that name the link: `WorkspaceSidebar.test.tsx`, `ReportsPage.test.tsx`, and the local-e2e `sidebar-workspace` and
  `report-workspace` specs.

The preview page's heading follows (taken next, on "continue"): "Chat workspace" becomes "AI preview" in `SyntheticAssistant.tsx`, with
its three assertions (`ReportsPage.test.tsx`, local-e2e `sidebar-workspace` and `interpretation-preview`). The CSS class `chat-workspace`
is internal and stays. Staging and hosted builds never show the entry or the page.
