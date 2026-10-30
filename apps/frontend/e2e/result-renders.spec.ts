import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './helpers';

// Spec 019 D02b, T107 (R3): render capture measured by a real browser on the test-only page. The e2e backend has no evaluations, so the render API and
// the acknowledgements API the page also calls are routed here, and the test asserts what the browser SENT; the server is proven by the jest API and
// database tests. Synthetic ids only, no clinical text.
const PATIENT = '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d';
const EVALUATION = '5a5d4f8b-be16-4cd3-8e6f-6b7c8d9e0f1a';
const result = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const pageFor = (ids: string[]) => `/e2e/result-acknowledgements?patient=${PATIENT}${ids.map((id) => `&result=${id}`).join('')}`;

interface SentEvent {
  kind: string;
  resultId: string;
  measurement: string;
  continuousMs: number;
}

/** Routes both APIs the page calls; returns every render event the browser sent, in order. */
async function routeApis(page: Page): Promise<SentEvent[]> {
  const sent: SentEvent[] = [];
  await page.route('**/api/v1/result-renders', async (route) => {
    const body = route.request().postDataJSON() as { events: SentEvent[] };
    sent.push(...body.events);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stored: body.events.length, alreadyStored: 0 }) });
  });
  await page.route('**/api/v1/evaluation-results/*/acknowledgements', async (route) => {
    const resultId = /evaluation-results\/([^/]+)\/acknowledgements/.exec(route.request().url())![1];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ resultId, evaluationId: EVALUATION, patientId: PATIENT, basis: ['active'], acknowledgements: [], clinicalUse: 'not-approved', actionable: false }),
    });
  });
  return sent;
}
const exposuresOf = (sent: SentEvent[], id: string) => sent.filter((e) => e.kind === 'exposure' && e.resultId === id);
const region = (page: Page, id: string) => page.getByRole('region', { name: `Recommendation summary, result ${id}` });

test.describe('render capture on the test-only page (render-v1)', () => {
  test('a row in view for at least one second sends exactly one exposure', async ({ page }) => {
    const sent = await routeApis(page);
    const id = result(1);
    await signInAs(page, 'bob', pageFor([id]));
    await expect(region(page, id)).toBeInViewport({ ratio: 0.5 });
    await expect.poll(() => exposuresOf(sent, id).length, { timeout: 5_000 }).toBe(1);
    const [exposure] = exposuresOf(sent, id);
    expect(exposure!.measurement).toBe('viewport');
    expect(exposure!.continuousMs).toBeGreaterThanOrEqual(1000); // the browser's own timer: one second, give or take its scheduling
    expect(exposure!.continuousMs).toBeLessThan(1500);
    await page.waitForTimeout(2_000);
    expect(exposuresOf(sent, id)).toHaveLength(1); // still in view: never a second exposure
  });

  test('a row in view for less than one second sends none; held in view, the same row sends one (control)', async ({ page }) => {
    const sent = await routeApis(page);
    const ids = Array.from({ length: 20 }, (_, i) => result(i + 1));
    const last = ids.at(-1)!;
    await signInAs(page, 'bob', pageFor(ids));
    await expect(region(page, ids[0]!)).toBeVisible();
    await expect(region(page, last)).not.toBeInViewport(); // control: the last row starts below the fold
    await region(page, last).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await region(page, ids[0]!).scrollIntoViewIfNeeded();
    await expect(region(page, last)).not.toBeInViewport();
    await page.waitForTimeout(2_500);
    expect(exposuresOf(sent, last)).toEqual([]);
    await region(page, last).scrollIntoViewIfNeeded();
    await expect.poll(() => exposuresOf(sent, last).length, { timeout: 5_000 }).toBe(1);
  });

  // Headless Chromium never reports a hidden page: neither bringing another tab to the front nor minimizing the window (Browser.setWindowBounds) changed
  // document.visibilityState from "visible" here. So this one test sets the document's visibility state and fires the real visibilitychange event;
  // the region's geometry, the IntersectionObserver and the timers stay the browser's own.
  test('a row on a hidden tab sends none; once the tab is shown, it sends one (control)', async ({ page }) => {
    const sent = await routeApis(page);
    const id = result(1);
    await signInAs(page, 'bob', `/e2e/result-acknowledgements?patient=${PATIENT}`); // no rows yet
    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await setVisibility('hidden');
    // In-app navigation (the session is held in memory, so a reload would sign out): the row appears, in view, while the tab is hidden.
    await page.evaluate(
      (url) => {
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      pageFor([id]),
    );
    await expect(region(page, id)).toBeInViewport({ ratio: 0.5 });
    await page.waitForTimeout(2_500);
    expect(exposuresOf(sent, id)).toEqual([]);
    await setVisibility('visible');
    await expect.poll(() => exposuresOf(sent, id).length, { timeout: 5_000 }).toBe(1);
  });
});
