import { useChat } from '@ai-sdk/react';
import { useMemo, useRef, useState } from 'react';
import { messageText, syntheticChatTransport, SYNTHETIC_FAILURE, type SyntheticMessage } from '@/lib/syntheticChatTransport';

/** Chat lifecycle belongs to the SDK; feedback and composer are session-local UI state. */
export function useSyntheticChat(allowed: boolean) {
  const [input, setInput] = useState('');
  const [question, setQuestion] = useState('');
  const [stage, setStage] = useState(0);
  const [status, setStatus] = useState('Choose a question to explore the example.');
  const [failNext, setFailNext] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, 'helpful' | 'not-helpful' | null>>({});
  const locked = useRef(false);
  const interrupted = useRef(false);
  const { messages, status: chatStatus, error: chatError, sendMessage, regenerate, stop, setMessages, clearError } = useChat<SyntheticMessage>({
    transport: syntheticChatTransport,
    onData: part => { if (part.type === 'data-stage' && !interrupted.current) setStage(part.data); },
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError && !interrupted.current) {
        setInput(''); setStatus('Fixed synthetic response ready.');
      }
    },
    onError: () => { if (!interrupted.current) setStatus(''); },
  });
  const turns = useMemo(() => messages.flatMap((message, index) => {
    const previous = messages[index - 1];
    const text = messageText(message);
    if (message.role !== 'assistant' || !text || previous?.role !== 'user') return [];
    return [{ id: message.id, question: messageText(previous), answer: text, feedback: feedback[message.id] ?? null }];
  }), [messages, feedback]);
  const busy = chatStatus === 'submitted' || chatStatus === 'streaming';
  const full = turns.length >= 6;
  // Keep only completed pairs when starting a different question or discarding an aborted turn.
  function completed(current: SyntheticMessage[]) {
    const last = current.findLastIndex(message => message.role === 'assistant' && !!messageText(message));
    return current.slice(0, last + 1);
  }
  async function submit(value: string, retry = false) {
    const clean = value.trim();
    if (!allowed || !clean || clean.length > 400 || locked.current || busy || full) return;
    locked.current = true; interrupted.current = false;
    setQuestion(clean); setInput(clean); setStage(0); setStatus('Loading a fixed synthetic response…');
    const simulateFailure = failNext; setFailNext(false); clearError();
    try {
      if (retry) await regenerate({ body: { simulateFailure } });
      else {
        setMessages(completed);
        await sendMessage({ text: clean }, { body: { simulateFailure } });
      }
    } finally { locked.current = false; }
  }
  async function cancel(reset = false) {
    interrupted.current = true;
    locked.current = true;
    await stop(); // Drain queued stream updates before discarding messages.
    setMessages(reset ? [] : completed); clearError();
    if (reset) { setInput(''); setQuestion(''); setFeedback({}); setFailNext(false); }
    setStatus(reset ? 'Preview reset. Choose a sample question.' : 'Demonstration stopped. No response was generated.');
    locked.current = false;
  }
  return {
    input, setInput, turns, pending: busy ? question : '', stage, status, full,
    error: chatError ? SYNTHETIC_FAILURE : '', failNext, setFailNext,
    submit, retry: () => submit(question, true), cancel,
    markFeedback: (id: string, value: 'helpful' | 'not-helpful' | null) => setFeedback(current => ({ ...current, [id]: value })),
  };
}
