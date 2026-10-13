import type { UIMessageChunk } from 'ai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syntheticChatTransport as transport, type SyntheticMessage } from './syntheticChatTransport';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('location', { hostname: '127.0.0.1' }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const messages: SyntheticMessage[] = [{ id: 'question', role: 'user', parts: [{ type: 'text', text: 'Explain this example' }] }];
function options(abortSignal?: AbortSignal) { return { chatId: 'test', trigger: 'submit-message' as const, messageId: undefined, messages, abortSignal }; }
it('streams SDK progress and text locally, with no fetch or resumable session', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const reader = (await transport.sendMessages(options())).getReader();
  const chunks: UIMessageChunk[] = [];
  const consume = (async () => { while (true) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); } })();
  await vi.advanceTimersByTimeAsync(1350); await consume;
  expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'data-stage', 'data-stage', 'text-start', 'text-delta', 'text-end', 'finish']);
  expect(chunks[1]).toMatchObject({ data: 1, transient: true });
  expect(chunks[4]).toMatchObject({ delta: expect.stringContaining('No genotype, phenotype') });
  expect(await transport.reconnectToStream({ chatId: 'test' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([0, 450, 900])('abort at %d ms rejects the stream and removes its timer', async elapsed => {
  const controller = new AbortController();
  const reader = (await transport.sendMessages(options(controller.signal))).getReader();
  await vi.advanceTimersByTimeAsync(elapsed);
  controller.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.getTimerCount()).toBe(0);
});
it('reader cancellation releases timers', async () => {
  const reader = (await transport.sendMessages(options())).getReader();
  await reader.cancel(); expect(vi.getTimerCount()).toBe(0);
});
it('already aborted requests never schedule work', async () => {
  const controller = new AbortController(); controller.abort();
  const reader = (await transport.sendMessages(options(controller.signal))).getReader();
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['production', 'remote'])('rejects direct transport use outside local DEV: %s', mode => {
  if (mode === 'production') vi.stubEnv('DEV', false);
  else vi.stubGlobal('location', { hostname: 'example.com' });
  return expect(transport.sendMessages(options())).rejects.toThrow('development-only');
});
