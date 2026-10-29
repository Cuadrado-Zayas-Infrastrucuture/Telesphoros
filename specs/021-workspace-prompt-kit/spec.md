# Feature Specification: One-screen workspace on Prompt Kit (WPK)

**Feature Branch**: `feat/workspace-prompt-kit`

**Created**: 2026-10-29

**Status**: Approved 2026-10-29 ("Yes, build it"), with the honest Source wording.

**Input**: The founder asked what Prompt Kit offers for a more premium experience. The app already holds 15 of its 19 components, used in the chat preview. The one-screen workspace (spec 016) used almost none of them.

## Decisions

- **D1, box:** Prompt Input and Prompt Suggestion replace the hand-built box and sample-question buttons. The file line, patient choice and Synthetic confirmation stay inside, unchanged. Prompt Input gains `label` and `allowEmpty`, so a file can be sent with no question; the page still validates.
- **D2, upload progress:** Steps shows "Sent to the server → Stored and checksum matched → Listed in your reports", from the server's attempt state (`lib/uploadSteps.ts`). "Listed" comes only from the upload resolving, never from a state. Steps gains `labels`, `words`, `label` and `colored`; its defaults are the chat preview's, uncolored.
- **D3, answering:** Thinking Bar, with its Text Shimmer and Stop control, replaces the spinner line.
- **D4, answers:** Message and Message Content with the mascot, Feedback Bar on the chat hook's existing local feedback, and Scroll Button once the reader is above the newest message.
- **D5, source (founder's decision):** after a verified upload, Source says "Attached: <file> · not read by the sample engine", and that the answer is a fixed example and not a clinical interpretation. With no upload it keeps the demo source. Source gains `title` and `description`; its defaults are the demo's.
- **D6, notice:** System Message carries "Synthetic data only. Not for clinical use." and any upload or answer error.
- **D7, not used:** File Upload (display-only by design; the workspace keeps the real, validated intake). Chain of Thought, Chat Container, Markdown and Code Block stay out for the reasons in `components/prompt-kit/README.md`.

## Out of scope

- The chat preview (`/local-interpretation`), production routes, the backend, the upload logic and patient handling.

## Requirements

- **WPK-1** With no new props, Steps, Source and Prompt Input render exactly as before; the chat preview's tests stay green.
- **WPK-2** No answer may suggest the engine read the uploaded report.
- **WPK-3** Brand rules hold in both themes: tokens only, status as words, 44 px targets; no axe violations.
