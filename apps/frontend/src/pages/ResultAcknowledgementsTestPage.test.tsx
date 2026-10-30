import { act, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import ResultAcknowledgementsTestPage from './ResultAcknowledgementsTestPage';

// Spec 019 D02b, T106: the test page gives each synthetic row a recommendation-summary region with its render capture attached. The API is a fake that
// refuses everything but render batches; IntersectionObserver is a fake (jsdom has none). Synthetic ids only.
const auth = vi.hoisted(() => ({ roles: ['reader'] as string[], apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/auth/AuthProvider', async (original) => ({ ...(await original<object>()), useAuth: () => auth }));

const R1 = '1c1f0b4d-7a72-4e9f-8a2b-2d3e4f5a6b7c';
const R2 = '3e3b2d6f-9c94-4ab1-8c4d-4f5a6b7c8d9e';
const P1 = '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d';

const observed = new Map<Element, IntersectionObserverCallback>();
class FakeObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    observed.set(target, this.callback);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  observed.clear();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  auth.apiFetch = vi.fn(async (path: string) =>
    path === '/api/v1/result-renders' ? new Response(JSON.stringify({ stored: 1, alreadyStored: 0 }), { status: 200 }) : new Response('{}', { status: 404 }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const page = () =>
  render(
    <RouterProvider router={createMemoryRouter([{ path: '/', element: <ResultAcknowledgementsTestPage /> }], { initialEntries: [`/?patient=${P1}&result=${R1}&result=${R2}`] })} />,
  );

describe('the test page’s recommendation-summary regions', () => {
  it('gives each row one focusable summary region holding its synthetic id and nothing clinical, and stays accessible', async () => {
    const view = page();
    const regions = await screen.findAllByRole('region', { name: /^Recommendation summary, result / });
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([`Recommendation summary, result ${R1}`, `Recommendation summary, result ${R2}`]);
    for (const [i, region] of regions.entries()) {
      expect(region.tabIndex).toBe(0);
      expect(within(region).getByText([R1, R2][i]!)).toBeDefined();
      expect(region.textContent).toBe(`Recommendation summary (synthetic)${[R1, R2][i]}`);
    }
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('attaches the render capture to each region: one second in view sends that row’s exposure only', async () => {
    vi.useFakeTimers();
    page();
    const regions = await vi.waitFor(() => {
      const found = screen.getAllByRole('region', { name: /^Recommendation summary, result / });
      if (found.length !== 2) throw new Error('not yet');
      return found;
    });
    const second = regions[1]!;
    act(() => observed.get(second)!([{ isIntersecting: true, intersectionRatio: 1, target: second } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const batches = auth.apiFetch.mock.calls.filter(([path]) => path === '/api/v1/result-renders').map(([, init]) => JSON.parse(String(init!.body)));
    expect(batches.flatMap((b) => b.events).map((e: { kind: string; resultId: string }) => [e.kind, e.resultId])).toEqual([['exposure', R2]]);
  });
});
