# The local-only "Chat preview" entry is called "AI preview"

Date: 2026-11-25

The founder chose this on 2026-11-25. In local builds only, the sidebar offered **Chat preview** for `/local-interpretation`, a design preview
of an interpretation assistant, while the header names the same page **AI preview**. With the chat retired (spec 052), "Chat preview"
read as if the chat were still there.

- The sidebar's entry reads "AI preview", and its fixed panel name follows. The word is no longer in `SIDEBAR_WORDS`. That table is in
  every build, and `check-foundation.mjs` refuses the string "AI preview" in production assets: it guards that the preview never ships,
  and CI's first run on this PR caught it. The local entries now sit behind `import.meta.env.DEV`, as the header's link already did, so
  a production build drops them and their words.
- The `chatPreview` row leaves `docs/design/spanish/ls2-shell.md`. A local-only English name needs no Spanish.
- Tests that name the link: `WorkspaceSidebar.test.tsx`, `ReportsPage.test.tsx`, and the local-e2e `sidebar-workspace` and
  `report-workspace` specs.

The preview page's heading follows (taken next, on "continue"): "Chat workspace" becomes "AI preview" in `SyntheticAssistant.tsx`, with
its three assertions (`ReportsPage.test.tsx`, local-e2e `sidebar-workspace` and `interpretation-preview`). The CSS class `chat-workspace`
is internal and stays. Staging and hosted builds never show the entry or the page.
