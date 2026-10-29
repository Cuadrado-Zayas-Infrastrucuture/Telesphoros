# Prompt Kit adaptations

Source: https://github.com/ibelick/prompt-kit/tree/5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a
MIT © 2025 Julien Thibeaut. License retained beside these components.

Selected `prompt-input.tsx` and `message.tsx` primitives are vendored following Prompt Kit's source-component distribution model. Split into one component per file for this repository; use Telesphoros tokens and existing Textarea/Button. Removed unused tooltip, avatar, markdown and autosize dependencies. Retained controlled input context, keyboard submission and message composition; added composition-event/loading guards and native form semantics. No remote avatars, HTML/markdown renderer, remote uploads, or model transport.

Prompt Kit is the UI layer. The existing `useSyntheticChat` hook uses `@ai-sdk/react`'s `useChat` with the local synthetic transport; no model is called. This sidebar revision reuses that lifecycle unchanged. A live transport requires a separately approved privacy/clinical/evaluation scope. The requested https://www.prompt-kit.com/ai-sdk guide returned HTTP 403 during this session; the official `ibelick/prompt-kit` source and the installed hook were inspected instead.

## Expanded preview adapters

The same pinned upstream was inspected for `tool`, `chain-of-thought`, `steps`, `reasoning`, `source`, `feedback-bar`, `file-upload`, `image`, `loader`, `text-shimmer`, `thinking-bar`, `scroll-button`, `system-message` and `prompt-suggestion`. Their selected structures are adapted here, rather than installing the entire registry or introducing a second theme.

- Tool and Steps present explicit simulated process status, not private chain-of-thought. Reasoning shows a concise explanation basis. Native details replaces Collapsible/hover cards and works with touch and keyboard. The limited ToolPart union is only for local fixtures; it is not a complete AI SDK v7 adapter.
- FileUpload uses scoped drop handlers, checks role/confirmation/loading for every path and retains only one file's display metadata. No global drop listener, FileReader, object URL, parser or network transfer.
- Image displays only the bundled synthetic SYN-D01 image in a native modal; it cannot render an uploaded file or an arbitrary URL. The browser restores focus on closing the dialog.
- Source omits upstream external favicon requests. SystemMessage and Tool omit arbitrary colors and pills. FeedbackBar uses local, per-exchange pressed state and 44px controls.
- Loader/ThinkingBar/TextShimmer share brand tokens, one accessible loading status, and reduced-motion/forced-colors handling. ScrollButton works with the route's actual bounded scroll region and moves focus to its stable end marker.
- Existing source files retained under this directory remain covered by the accompanying MIT notice.

## Chat reasoning and source presentation

The workspace now composes the existing Prompt Kit Reasoning, ThinkingBar, SystemMessage and Source adapters in the conversation. Each completed exchange has a collapsed explanation summary, with distinct matched-example and fallback descriptions. SourceTrigger opens the existing drawer directly to its expanded fixture source; the toolbar still opens general report context. The three preparation phases are explicitly simulated, use the existing SDK stage events, and disappear on Stop/error/completion. The visible System message is a UI notice; model prompts and transport are unchanged.

The upstream docs again returned 403; the four pinned official source components were inspected directly. Native disclosure, local source details, project tokens, 44px controls and reduced-motion styles are retained. No dependencies, remote favicons, model calls or clinical citations were added.

## Registry items deliberately not adopted (2026-10-27)

Checked against the 23 items in `https://prompt-kit.com/c/registry.json` (spec 005, slice 3). Each one below was left out for a reason, not overlooked:

| Item | Why not |
| --- | --- |
| `chat-container` | `SyntheticAssistant` already follows the newest message, stops following when the reader scrolls up, and offers ScrollButton. Upstream would add `use-stick-to-bottom` to replace working code. |
| `response-stream` | A typing animation adds motion and delays reading. Synthetic answers arrive whole. |
| `markdown`, `code-block` | Removed earlier with the HTML/markdown renderer. Answers render as text. |
| `jsx-preview` | Renders JSX it is given. Model or user text must never become markup. |
| `chain-of-thought` | Tool and Steps show simulated process status, never private reasoning (above). |
| `chatbot`, `tool-calling` | Full blocks with server routes and a live model. A live transport needs its own privacy, clinical and evaluation approval. |

The full chat workspace now fades messages under `ProgressiveBlur` at the conversation's top edge (`components/motion-primitives`). The embedded assistant has no edge: at 5 to 7rem tall, a 3rem edge would cover half of it.

## Reuse in the one-screen workspace (specs/021, 2026-10-29)

`/local-workspace` now composes these adapters too. Three gained optional props, and each default keeps the chat preview unchanged (covered by `kitDefaults.test.tsx`):

- `Steps`: `labels`, `words`, `label` and `colored`. The workspace passes the real upload's steps, from `lib/uploadSteps.ts`.
- `Source`: `title` and `description`. A caller must say plainly what the answer did not read. The workspace says the sample engine did not read the attached report.
- `PromptInput`: `label` and `allowEmpty`, so a file can be sent without a question. The caller still validates.

`FileUpload` stays display-only and is not used there. The workspace keeps the real, validated intake.
