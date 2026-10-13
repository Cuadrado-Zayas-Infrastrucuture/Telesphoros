# Prompt Kit, OpenAI SDK and Vercel AI SDK

Reviewed 2026-10-13 against official documentation and the pinned Prompt Kit source. The founder subsequently approved applying Vercel AI SDK to the synthetic preview. The implementation pins `@ai-sdk/react` 4.0.142 and `ai` 7.0.139 (Node >=22). It uses real `useChat` with an in-memory `ChatTransport`; no provider credentials or network-backed AI feature was added.

| Layer | Verified purpose | Fit for Telesphoros |
| --- | --- | --- |
| Prompt Kit | Source-distributed React UI components | Branded input, messages, sources, local feedback and process presentation. It does not perform inference. |
| Vercel AI SDK UI | React chat state, transport, message parts, status, cancellation and regeneration | Implemented for the local synthetic preview in this React/Vite app. Server transport would still use the existing authenticated application boundary. |
| Vercel AI SDK Core + OpenAI provider | Provider abstraction; OpenAI Responses API support | One possible future server-side implementation. It does not require replacing the current app with Next.js or choosing a hosted deployment. |
| Official OpenAI JavaScript/TypeScript SDK | Direct OpenAI API client with typed streaming events | Alternative for direct integration in the existing backend. Requires adapting its event stream to whichever UI transport contract is chosen. |

Sources: [Prompt Kit](https://github.com/ibelick/prompt-kit/tree/5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a), [AI SDK introduction](https://ai-sdk.dev/docs/introduction), [AI SDK chat UI](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot), [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [OpenAI TypeScript reference](https://developers.openai.com/api/reference/typescript).

## Recommendation

Keep Prompt Kit as the presentation layer. If a live integration is later approved, use AI SDK UI for client chat behavior and select one backend path: AI SDK Core with its OpenAI provider, or the official OpenAI SDK plus an explicit stream adapter. Avoid installing both server clients for the same request path without a concrete need. This recommendation is an architectural inference from the interfaces above, not a benchmark result.

Clinical authorization and evidence checks belong on the server. A frontend tool card must never create authority to parse a report, run a clinical engine or execute a write. Provider keys stay off the browser. Consent, retention configuration, approved evidence binding, cancellation across the transport, and model/prompt evaluations are separate implementation decisions; nothing in this preview establishes them.

## Tool and reasoning compatibility

The referenced Prompt Kit `ToolPart` at the pinned revision handles four states: input streaming, input available, output available and output error. Current AI SDK tool documentation also includes approval requested/responded and output denied. Do not cast live SDK message parts into that narrower type: explicitly map supported states and refuse unknown/unsupported actions. This preview's type is intentionally limited to its own synthetic animation. [Prompt Kit Tool source](https://github.com/ibelick/prompt-kit/blob/5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a/components/prompt-kit/tool.tsx), [AI SDK tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage).

OpenAI exposes supported reasoning summaries, not raw private reasoning tokens. A future explanation-basis disclosure may display a supported, clearly labeled summary and verified tool/evidence status. It must not fabricate hidden thoughts or conflate a narrative explanation with an independently established guideline result. The present Steps/Tool animation is explicitly simulated and the explanation basis describes the actual fixed-fixture selection. [OpenAI reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning), [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses).

The Prompt Kit website returned 403 to this research tool, so the requested Tool documentation was verified against the official repository source at the pinned revision, not a third-party tutorial. The fetched Vercel documentation identifies itself as v7. Actual installed package types and source were checked for this synthetic integration; live provider integration remains deferred.

## Requested UI inventory

| Requested pattern | Implementation in this preview |
| --- | --- |
| Product logo | Existing shield/Rx restored unchanged in shared header; 72px welcome mark |
| Chain of thought / steps | Public, simulated process steps inside Tool disclosure |
| Reasoning | Explanation basis disclosure describing fixed sample selection |
| Tool | Branded, expandable running/complete/error presentation; no execution |
| Feedback bar | Per-message helpful/not-helpful state; local only |
| File uploader | Writer-role, confirmed synthetic metadata selection/drop; no byte reads or upload |
| Image | Bundled synthetic source image in keyboard/Escape-capable native dialog |
| Loader / thinking bar / text shimmer | Staged local loading with reduced-motion and forced-colors handling |
| Message | Bounded six-exchange conversation, text rendered safely |
| Prompt input / suggestion | Labeled composer, Enter/Shift+Enter/IME handling, preset questions |
| Scroll button | Latest-message control; preserves the reader's position when scrolled up |
| Source | Touch/keyboard disclosure; no external favicon request or invented citation |
| System message | Clear synthetic boundary and actionable simulated error |

## Approved synthetic SDK integration

`useSyntheticChat` adapts SDK messages/status into the existing Prompt Kit presentation. `sendMessage` starts each question; `regenerate` retries its retained user message without adding a duplicate. `stop` is awaited before reset/discard so queued updates cannot revive old exchanges. The SDK hook stops on unmount. Feedback and the composer remain local UI state.

`syntheticChatTransport` returns an in-memory `ReadableStream<UIMessageChunk>` with start, transient `data-stage` progress, text start/delta/end and finish events. The fixed answer is delivered as one text delta after the simulated stages; this is protocol integration, not token generation. Abort or reader cancellation clears the stage timer and listener. Reconnection returns null. Direct use outside DEV/127.0.0.1 is rejected. No `DefaultChatTransport`, provider client, HTTP endpoint, MCP connection or model is configured. SDK transitive packages are installed but not activated as services.

Production source-map checks reject AI SDK and synthetic transport modules as well as the existing fixture-marker checks. The entry remains 113.3 KiB gzip. See [verification](../verification/prompt-kit-interpretation-preview.md). API references: [custom transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport), [useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat). No Next.js migration or Vercel hosting is required.
