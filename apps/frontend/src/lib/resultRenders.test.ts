import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResultRenderEvent } from '@telesphoros/shared-types';
import { RENDER_RETRY_MS, RenderQueue } from './resultRenders';

// The queue's delivery rules are exercised in the browser suites (specs/019). These cases cover the one rule specs/038 adds: an API that
// says the route is switched off is not asked again in this session, while an ordinary outage is still retried.

const event = (episodeId: string): ResultRenderEvent =>
  ({
    episodeId,
    seq: 0,
    kind: 'exposure',
    resultId: '55555555-5555-4555-8555-555555555555',
    measurement: 'focus',
    occurredAt: '2026-11-12T12:00:00.000Z',
    continuousMs: 1000,
    cumulativeMs: 1000,
  }) as ResultRenderEvent;
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('an API that says the route is switched off is not asked again: nothing is retried and later events are not sent', async () => {
  const apiFetch = vi.fn(async () => reply(503, { error: { code: 'PIPELINE_DISABLED' } }));
  const queue = new RenderQueue(apiFetch);
  queue.enqueue(event('11111111-1111-4111-8111-111111111111'), 'now');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(queue.pending()).toEqual([]);
  queue.enqueue(event('22222222-2222-4222-8222-222222222222'), 'now');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(queue.pending()).toEqual([]);
});

it('control: an ordinary 503 is an outage, so the batch is retried and later events are still sent', async () => {
  const apiFetch = vi.fn(async () => reply(503, { error: { code: 'UNAVAILABLE' } }));
  const queue = new RenderQueue(apiFetch);
  queue.enqueue(event('11111111-1111-4111-8111-111111111111'), 'now');
  await vi.advanceTimersByTimeAsync(RENDER_RETRY_MS[0]);
  expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
  const before = apiFetch.mock.calls.length;
  apiFetch.mockImplementation(async () => reply(200, { stored: 1, duplicates: 0 }));
  queue.enqueue(event('22222222-2222-4222-8222-222222222222'), 'now');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(apiFetch.mock.calls.length).toBeGreaterThan(before);
  expect(queue.pending()).toEqual([]);
});

it('control: a 503 with no readable body is treated as an outage, not as switched off', async () => {
  const apiFetch = vi.fn(async () => reply(503));
  const queue = new RenderQueue(apiFetch);
  queue.enqueue(event('11111111-1111-4111-8111-111111111111'), 'now');
  await vi.advanceTimersByTimeAsync(RENDER_RETRY_MS[0]);
  expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
});
