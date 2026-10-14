# Prompt Kit adaptations

Source: https://github.com/ibelick/prompt-kit/tree/5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a
MIT © 2025 Julien Thibeaut. License retained beside these components.

Selected `prompt-input.tsx` and `message.tsx` primitives are vendored following Prompt Kit's source-component distribution model. Split into one component per file for this repository; use Telesphoros tokens and existing Textarea/Button. Removed unused tooltip, avatar, markdown and autosize dependencies. Retained controlled input context, keyboard submission and message composition; added composition-event/loading guards and native form semantics. No remote avatars, HTML/markdown renderer, remote uploads, or model transport.

Prompt Kit is the UI layer, not an inference SDK. This preview deliberately does not install Vercel AI SDK or call a model. A future authorized transport integration requires its own privacy/clinical/evaluation scope.

## Expanded preview adapters

The same pinned upstream was inspected for `tool`, `chain-of-thought`, `steps`, `reasoning`, `source`, `feedback-bar`, `file-upload`, `image`, `loader`, `text-shimmer`, `thinking-bar`, `scroll-button`, `system-message` and `prompt-suggestion`. Their selected structures are adapted here, rather than installing the entire registry or introducing a second theme.

- Tool and Steps present explicit simulated process status, not private chain-of-thought. Reasoning shows a concise explanation basis. Native details replaces Collapsible/hover cards and works with touch and keyboard. The limited ToolPart union is only for local fixtures; it is not a complete AI SDK v7 adapter.
- FileUpload uses scoped drop handlers, checks role/confirmation/loading for every path and retains only one file's display metadata. No global drop listener, FileReader, object URL, parser or network transfer.
- Image displays only the bundled synthetic SYN-D01 image in a native modal; it cannot render an uploaded file or an arbitrary URL. The browser restores focus on closing the dialog.
- Source omits upstream external favicon requests. SystemMessage and Tool omit arbitrary colors and pills. FeedbackBar uses local, per-exchange pressed state and 44px controls.
- Loader/ThinkingBar/TextShimmer share brand tokens, one accessible loading status, and reduced-motion/forced-colors handling. ScrollButton works with the route's actual bounded scroll region and moves focus to its stable end marker.
- Existing source files retained under this directory remain covered by the accompanying MIT notice.
