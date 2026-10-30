import { act, render } from '@testing-library/react';
import { resultRenderBatchSchema, type ResultRenderEvent } from '@telesphoros/shared-types';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDER_MAX_ATTEMPTS } from '@/lib/resultRenders';
import { useResultRender } from './useResultRender';

// Spec 019 D02b, T105: the render-v1 rule and its delivery, with fake timers. The browser APIs are hand-written fakes (jsdom has no IntersectionObserver
// and never hides a tab); the real browser is R3's Playwright test. Every expected event is written by hand. Synthetic ids only.
const auth = vi.hoisted(() => ({ apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/auth/AuthProvider', async (original) => ({ ...(await original<object>()), useAuth: () => auth }));

const R1 = '1c1f0b4d-7a72-4e9f-8a2b-2d3e4f5a6b7c';
const R2 = '3e3b2d6f-9c94-4ab1-8c4d-4f5a6b7c8d9e';
const P1 = '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d';
const P2 = '4f4c3e7a-ad05-4bc2-9d5e-5a6b7c8d9e0f';

/** The one IntersectionObserver fake: `show(ratio)` reports the observed region at that ratio. */
let observers: FakeObserver[] = [];
class FakeObserver {
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  target: Element | undefined;
  observe(target: Element) {
    this.target = target;
  }
  disconnect() {
    observers = observers.filter((o) => o !== this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function show(ratio: number) {
  for (const o of observers) {
    o.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio, target: o.target! } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver);
  }
}

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function Probe({ resultId, patientId }: { resultId: string; patientId?: string }) {
  const region = useRef<HTMLDivElement>(null);
  useResultRender(resultId, region, patientId);
  return (
    <div ref={region} data-testid="region">
      <button type="button">Inside</button>
      <button type="button">Also inside</button>
    </div>
  );
}
const outside = () => document.getElementById('outside') as HTMLButtonElement;

const posts = () => auth.apiFetch.mock.calls.filter(([path, init]) => path === '/api/v1/result-renders' && init?.method === 'POST');
const sent = () => posts().map(([, init]) => resultRenderBatchSchema.parse(JSON.parse(String(init!.body))));
const events = (): ResultRenderEvent[] => sent().flatMap((b) => b.events);
const exposures = () => events().filter((e) => e.kind === 'exposure');
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T15:00:00.000Z'));
  observers = [];
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  // A new function per test: the queue is per session (per apiFetch), so nothing held carries over.
  auth.apiFetch = vi.fn(async () => new Response(JSON.stringify({ stored: 1, alreadyStored: 0 }), { status: 200 }));
  const button = document.createElement('button');
  button.id = 'outside';
  document.body.append(button);
});
afterEach(() => {
  outside()?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('render-v1 on the viewport path', () => {
  it('under one continuous second sends nothing, even later', async () => {
    render(<Probe resultId={R1} />);
    show(1);
    await wait(999);
    show(0);
    await wait(20_000);
    expect(posts()).toEqual([]);
  });

  it('one continuous second sends exactly one exposure at once, with ids and times only', async () => {
    render(<Probe resultId={R1} />);
    show(0.6);
    await wait(1000);
    expect(posts()).toHaveLength(1);
    const [exposure] = events();
    expect(exposure).toEqual({
      episodeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      seq: 0,
      kind: 'exposure',
      resultId: R1,
      measurement: 'viewport',
      ruleVersion: 'render-v1',
      schemaVersion: 1,
      capability: ['intersection-observer', 'page-visibility', 'focus-events'],
      occurredAt: '2026-10-29T15:00:01.000Z',
      continuousMs: 1000,
      cumulativeMs: 1000,
    });
    expect(posts()[0]![1]!.keepalive).toBe(false);
    await wait(30_000);
    expect(exposures()).toHaveLength(1); // still in view: durations follow, never a second exposure
  });

  it('under half in view is not in view', async () => {
    render(<Probe resultId={R1} />);
    show(0.49);
    await wait(5000);
    expect(posts()).toEqual([]);
  });

  it('two short intervals do not add up to one: the interval resets when the region leaves the viewport', async () => {
    render(<Probe resultId={R1} />);
    show(1);
    await wait(600);
    show(0);
    show(1);
    await wait(600);
    show(0);
    await wait(10_000);
    expect(posts()).toEqual([]);
  });

  it('a hidden tab sends nothing, and hiding resets the interval', async () => {
    render(<Probe resultId={R1} />);
    setVisibility('hidden');
    show(1);
    await wait(5000);
    expect(posts()).toEqual([]);
    setVisibility('visible');
    await wait(600);
    setVisibility('hidden');
    setVisibility('visible');
    await wait(600);
    expect(posts()).toEqual([]);
    await wait(400); // 1000 ms since the tab came back
    expect(exposures()).toHaveLength(1);
  });

  it('a change of result or patient ends the interval: 700 ms before and 700 ms after send nothing', async () => {
    const view = render(<Probe resultId={R1} patientId={P1} />);
    show(1);
    await wait(700);
    view.rerender(<Probe resultId={R2} patientId={P1} />);
    show(1);
    await wait(700);
    view.rerender(<Probe resultId={R2} patientId={P2} />);
    show(1);
    await wait(700);
    expect(posts()).toEqual([]);
    await wait(300);
    expect(exposures().map((e) => e.resultId)).toEqual([R2]); // only the row now shown, after its own full second
  });
});

describe('the focus path (assistive technology and keyboard)', () => {
  it('focus inside the region for one second is an exposure of its own path; focus leaving sooner sends nothing', async () => {
    const view = render(<Probe resultId={R1} />);
    const inside = view.getByRole('button', { name: 'Inside' });
    act(() => inside.focus());
    await wait(900);
    act(() => outside().focus());
    await wait(10_000);
    expect(posts()).toEqual([]);
    act(() => view.getByRole('button', { name: 'Also inside' }).focus());
    await wait(500);
    act(() => inside.focus()); // still inside: the interval continues
    await wait(500);
    expect(exposures().map((e) => [e.measurement, e.continuousMs])).toEqual([['focus', 1000]]);
  });

  it('without IntersectionObserver only the focus path runs, and says so in its capability', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const view = render(<Probe resultId={R1} />);
    act(() => view.getByRole('button', { name: 'Inside' }).focus());
    await wait(1000);
    expect(exposures().map((e) => [e.measurement, e.capability])).toEqual([['focus', ['page-visibility', 'focus-events']]]);
  });
});

describe('durations and delivery (P4)', () => {
  it('records duration rows while the episode continues and a last one when it ends, batched, with continuous and cumulative time', async () => {
    render(<Probe resultId={R1} />);
    show(1);
    await wait(400);
    show(0); // a short interval first: it counts in the cumulative time only
    show(1);
    await wait(1000); // exposure
    expect(posts()).toHaveLength(1);
    await wait(5000); // checkpoint at 6 s of this interval, held for the batch
    expect(posts()).toHaveLength(1);
    await wait(3000);
    show(0); // ends at 9 s
    await wait(5000); // the batching delay
    expect(posts()).toHaveLength(2);
    expect(events().map((e) => [e.seq, e.kind, e.continuousMs, e.cumulativeMs])).toEqual([
      [0, 'exposure', 1000, 1400],
      [1, 'duration', 6000, 6400],
      [2, 'duration', 9000, 9400],
    ]);
    expect(new Set(events().map((e) => e.episodeId)).size).toBe(1);
  });

  it('a lost answer is retried a bounded number of times, then dropped; a refusal is not retried', async () => {
    auth.apiFetch = vi.fn(async () => {
      throw new TypeError('network');
    });
    const times = () => {
      const n = new Map<string, number>();
      for (const e of events()) n.set(`${e.episodeId}:${e.seq}`, (n.get(`${e.episodeId}:${e.seq}`) ?? 0) + 1);
      return [...n.values()];
    };
    render(<Probe resultId={R1} />);
    show(1);
    await wait(1000);
    show(0); // an exposure and its last duration
    await wait(120_000);
    expect(times()).toEqual([RENDER_MAX_ATTEMPTS, RENDER_MAX_ATTEMPTS]); // each event the same number of times, never a new one
    const before = posts().length;
    auth.apiFetch.mockImplementation(async () => new Response('{}', { status: 409 }));
    show(1);
    await wait(1000);
    show(0);
    await wait(120_000);
    expect(posts().length - before).toBe(2); // the new exposure and its duration, each refused once and dropped
    expect(times()).toEqual([RENDER_MAX_ATTEMPTS, RENDER_MAX_ATTEMPTS, 1, 1]);
  });

  it('hiding the page ends the episode and sends what is held at once with keepalive', async () => {
    render(<Probe resultId={R1} />);
    show(1);
    await wait(3000);
    expect(posts()).toHaveLength(1);
    setVisibility('hidden');
    await wait(0);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]![1]!.keepalive).toBe(true);
    expect(sent()[1]!.events.map((e) => [e.kind, e.continuousMs])).toEqual([['duration', 3000]]);
  });

  it('pagehide sends the episode’s last row with keepalive', async () => {
    render(<Probe resultId={R1} />);
    show(1);
    await wait(2000);
    act(() => void window.dispatchEvent(new Event('pagehide')));
    await wait(0);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]![1]!.keepalive).toBe(true);
    expect(sent()[1]!.events.map((e) => [e.kind, e.continuousMs])).toEqual([['duration', 2000]]);
  });

  it('unmounting ends the episode with a last row; nothing is ever shown on the page', async () => {
    const view = render(<Probe resultId={R1} />);
    show(1);
    await wait(1500);
    view.unmount();
    await wait(10_000);
    expect(events().map((e) => [e.kind, e.continuousMs])).toEqual([
      ['exposure', 1000],
      ['duration', 1500],
    ]);
    expect(document.body.textContent).not.toMatch(/render|exposure|failed/i);
  });
});
