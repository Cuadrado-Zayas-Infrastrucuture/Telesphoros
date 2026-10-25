import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { demoAnswer } from './interpretationDemo';

export type SyntheticMessage = UIMessage<never, { stage: number }>;
export const SYNTHETIC_FAILURE = 'Demonstration response unavailable. This is a simulated failure.';
export function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** In-memory AI SDK protocol fixture. No HTTP, provider, file access or tool execution. */
export const syntheticChatTransport: ChatTransport<SyntheticMessage> = {
  async sendMessages({ messages, abortSignal, body }) {
    if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') throw new Error('Synthetic transport is development-only.');
    const question = messages.findLast((message) => message.role === 'user');
    if (!question || messageText(question).length > 400 || messages.length > 12) throw new Error('Invalid synthetic conversation.');
    const answer = demoAnswer(messageText(question));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        let settled = false;
        cleanup = () => {
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          if (settled) return;
          cleanup();
          controller.error(new DOMException('Synthetic response stopped.', 'AbortError'));
        };
        abortSignal?.addEventListener('abort', abort, { once: true });
        if (abortSignal?.aborted) {
          abort();
          return;
        }
        controller.enqueue({ type: 'start', messageId: crypto.randomUUID() });
        function advance(stage: number) {
          timer = setTimeout(() => {
            if (settled) return;
            if (stage < 3) {
              controller.enqueue({ type: 'data-stage', data: stage, transient: true });
              advance(stage + 1);
              return;
            }
            cleanup();
            if (body && 'simulateFailure' in body && body.simulateFailure === true) {
              controller.error(new Error(SYNTHETIC_FAILURE));
              return;
            }
            controller.enqueue({ type: 'text-start', id: 'synthetic-answer' });
            controller.enqueue({ type: 'text-delta', id: 'synthetic-answer', delta: answer });
            controller.enqueue({ type: 'text-end', id: 'synthetic-answer' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          }, 450);
        }
        advance(1);
      },
      cancel() {
        cleanup();
      },
    });
  },
  async reconnectToStream() {
    return null;
  },
};
