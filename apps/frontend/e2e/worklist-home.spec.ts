import { expect, test, type Page, type Route } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInWithPatient } from './helpers';

// Spec 049 W2: the worklist home in a real browser, at the two widths every browser test runs at (375 and 1280 px), light and dark, by
// keyboard. The e2e API runs on the in-memory store, where follow-ups answer 503 by design (ledgered records exist only on PostgreSQL, as
// docs/status/2026-11-23-e2e-demographics-memory.md records for demographics) and no evaluation exists, so the two reads are served here from
// a synthetic fixture about a real e2e patient; everything else, the patient's label included, is the real app against the real e2e API.

const fulfil = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true', vary: 'Origin' },
    body: JSON.stringify(body),
  });

const followupsFor = (patient: { id: string; label: string }) => ({
  currentActor: 'person-1',
  items: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0',
      threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0',
      patientId: patient.id,
      patientLabel: patient.label,
      medicationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd0',
      medicationName: 'drugone',
      decisionId: null,
      version: 1,
      action: 'schedule',
      assessment: null,
      note: 'Synthetic reminder.',
      noteRedacted: false,
      next: { date: '2026-11-01', timezone: 'America/Puerto_Rico', assignee: 'person-1' },
      createdAt: '2026-10-20T12:00:00.000Z',
      createdBy: 'person-1',
      current: true,
      dueState: 'overdue',
      needsReassignment: false,
    },
  ],
  page: 1,
  hasMore: false,
  counts: { overdue: 1, today: 0, upcoming: 0, unassigned: 0 },
});

const heldFor = (patientId: string) => ({
  data: [
    {
      id: '66666666-6666-4666-8666-666666666660',
      reportId: '11111111-1111-4111-8111-111111111110',
      patientId,
      captureId: null,
      acceptance: null,
      disposition: 'held',
      holdCode: 'gene-absent',
      hold: { message: 'A needed gene result is missing.', reviewerAction: 'Ask the laboratory for it.' },
      knowledgeSetId: 'a'.repeat(64),
      engineVersion: 'sha256-abcdef012345',
      scope: 'synthetic-structured-assessment',
      clinicalUse: 'not-approved',
      state: 'active',
      supersededBy: null,
      results: [],
      geneStates: [],
      corrections: [],
      current: true,
      advisory: { activeDisputes: 0, patientLink: 'verified', knowledge: { evaluatedWith: 'set', loadedNow: 'set', status: 'same' } },
      actionable: false,
      createdAt: '2026-11-04T00:00:00Z',
    },
  ],
  meta: { page: 1, pageSize: 5, total: 3, totalPages: 1 },
});

/** Signs in, serves the two reads from the fixture and opens Home from the sidebar (a reload would lose the in-memory session). */
async function openWorklist(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme });
  const patient = await signInWithPatient(page);
  await page.route(
    (url) => url.pathname === '/api/v1/followups',
    (route) => fulfil(route, 200, followupsFor(patient)),
  );
  await page.route(
    (url) => url.pathname === '/api/v1/evaluations',
    (route) => fulfil(route, 200, heldFor(patient.id)),
  );
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
  const held = page.getByRole('region', { name: 'Held results' });
  await expect(held.getByRole('link', { name: `Open held result for ${patient.label}` })).toBeVisible();
  return { patient, held };
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the worklist reads at this width in the ${colorScheme} theme: both sections, no sideways scroll, no WCAG A/AA violation`, async ({ page }) => {
    const { patient, held } = await openWorklist(page, colorScheme);
    await expect(held.getByText('A needed gene result is missing. Ask the laboratory for it.')).toBeVisible();
    await expect(held.getByText('3 held results in all. Each patient’s page lists their own.')).toBeVisible();
    const followups = page.getByRole('region', { name: 'Follow-ups assigned to you' });
    await expect(followups.getByRole('link', { name: `Open follow-up for ${patient.label}, drugone` })).toBeVisible();
    await expect(followups.getByText('Overdue means the reminder date has passed. It does not indicate the level of clinical urgency.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('every control on the worklist is a 44 px target, and its headings start at h1 and go down one level at a time', async ({ page }) => {
  await openWorklist(page, 'light');
  const worklist = page.getByRole('main');
  const small = await worklist.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('a, button')]
      .filter((el) => !el.closest('[hidden]'))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
  );
  expect(small).toEqual([]);
  const levels = await worklist.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter((el) => el.getClientRects().length > 0).map((el) => Number(el.tagName[1])),
  );
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 2).length).toBeGreaterThanOrEqual(2); // the two sections
  for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
});

test('by keyboard: from the quick actions to a held result, and Enter opens the patient', async ({ page }) => {
  const { patient, held } = await openWorklist(page, 'light');
  await page.getByRole('group', { name: 'Start here' }).getByRole('link', { name: 'Find a patient' }).focus();
  const target = held.getByRole('link', { name: `Open held result for ${patient.label}` });
  for (let step = 0; step < 20 && !(await target.evaluate((el) => el === document.activeElement)); step++) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/patients/${patient.id}#patient-results$`));
});
