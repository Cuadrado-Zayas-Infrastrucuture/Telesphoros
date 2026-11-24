import { createRequire } from 'node:module';
import { expect, test, type Page, type Route } from '@playwright/test';
import { openPatients, signInWithPatient } from './helpers';

const require = createRequire(import.meta.url);

// Spec 044 slice B part 2 (plan-slice-b2.md section 5): the genomic profile in a real browser, at the two widths every browser test runs at
// (375 and 1280 px), light and dark, by keyboard. The e2e backend holds no evaluations, so the profile route is served here from a fixture;
// the rest of the patient page is the real app against the real e2e API. Invented genes and phenotypes and placeholder wording: nothing here
// is CPIC content.
const EVALUATION = '66666666-6666-4666-8666-666666666666';
const REPORT = '11111111-1111-4111-8111-111111111111';
const RESULT = '55555555-5555-4555-8555-555555555551';

const profileFor = (patientId: string) => ({
  patientId,
  clinicalUse: 'not-approved',
  capped: false,
  genes: [
    {
      gene: 'GENEA',
      status: 'resolved',
      sources: [
        {
          evaluationId: EVALUATION,
          reportId: REPORT,
          evaluatedAt: '2026-11-04T00:00:00Z',
          state: 'canonical',
          phenotype: 'Poor Metabolizer',
          diplotype: '*2/*2',
          activityScore: null,
          reasonCode: null,
        },
      ],
    },
  ],
  awaitingLinkReview: [],
  medications: [
    {
      rxcui: '36567',
      name: 'simvastatin',
      word: 'review',
      knowledgeChanged: false,
      conflict: false,
      results: [
        {
          evaluationId: EVALUATION,
          resultId: RESULT,
          outcome: 'shown',
          reasonCode: null,
          strength: 'Strong',
          recommendationText: '[Synthetic recommendation text]',
          implication: null,
          citation: { guidelineId: 'syn-guideline', guidelineVersion: '1', locator: { table: 'Table 2', row: 'Synthetic Poor' }, verification: 'verified' },
          genes: ['GENEA'],
          scope: 'synthetic-patient-signed-knowledge',
        },
      ],
    },
  ],
  check: null,
  modifierLists: { loaded: false },
});

const section = (page: Page) => page.locator('section[aria-labelledby="genomic-profile-heading"]');

/** Opens the patient's page the way a person does: the Patients list, then the patient's link (a reload would lose the in-memory session). */
async function openPatientPage(page: Page, label: string) {
  await openPatients(page);
  await expect(page.getByRole('list', { name: 'Patients' })).toBeVisible();
  const link = page.getByRole('link', { name: label, exact: true });
  const more = page.getByRole('button', { name: 'More patients', exact: true });
  for (let attempts = 0; attempts < 100 && (await link.count()) === 0; attempts++) {
    if ((await more.count()) === 0) break;
    await more.click();
    await expect.poll(async () => (await link.count()) > 0 || (await more.count()) === 0 || (await more.isEnabled())).toBe(true);
  }
  await link.click();
}

/** Signs in, creates a synthetic patient, serves its profile from the fixture and opens its page. */
async function openProfile(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme });
  const patient = await signInWithPatient(page);
  // The API is another origin than the app, so the browser reads a fulfilled response only with the CORS headers the real API would send.
  const fulfil = (route: Route, status: number, body: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true', vary: 'Origin' },
      body: JSON.stringify(body),
    });
  await page.route(
    (url) => url.pathname === `/api/v1/patients/${patient.id}/genomic-profile`,
    (route) => fulfil(route, 200, profileFor(patient.id)),
  );
  // The e2e API runs on the in-memory store, which by design has no demographics: they are ledgered records (spec 025 D5), the ledger exists only
  // on PostgreSQL, so the route answers 503 (UnavailablePatientDemographicsRepository, storage.module.ts). No setting in playwright.config.ts changes
  // that. Without them the page shows its "identity could not be loaded" state, which hides "Record a decision" (patient-identity-unknown.spec.ts
  // tests that state), so answer as the PostgreSQL API does for a patient with none recorded yet.
  // The real route is browser-tested on PostgreSQL in storage-e2e/patient-demographics.spec.ts (the nightly e2e-storage suite).
  await page.route(
    (url) => url.pathname === `/api/v1/patients/${patient.id}/demographics`,
    (route) => fulfil(route, 404, { error: { code: 'not-found', message: 'No demographics are recorded.', details: [{ reason: 'no-demographics' }] } }),
  );
  await openPatientPage(page, patient.label);
  try {
    await expect(section(page)).toContainText('1 of 1 current medication has guidance to review', { timeout: 15_000 });
  } catch (error) {
    // Say where the browser was and what the page showed, so a failure in CI can be read without the screenshot.
    const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2000);
    throw new Error(`The genomic profile did not show at ${page.url()}. The page said: ${shown}`, { cause: error });
  }
}

/** WCAG 2.0/2.1 A and AA violations inside the genomic profile section only, colour contrast included. */
async function sectionViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    const target = document.querySelector('section[aria-labelledby="genomic-profile-heading"]')!;
    // @ts-expect-error axe is injected into the page above
    const results = await window.axe.run(target, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the genomic profile reads at this width in the ${colorScheme} theme: no sideways scroll, no WCAG A/AA violation`, async ({ page }) => {
    await openProfile(page, colorScheme);
    await section(page).getByRole('button', { name: 'Why, and the evidence' }).click();
    await expect(section(page).getByRole('heading', { name: 'The evidence' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await sectionViolations(page)).toEqual([]);
  });
}

test('every control in the genomic profile is a 44 px target, and its headings go down one level at a time', async ({ page }) => {
  await openProfile(page, 'light');
  await section(page).getByRole('button', { name: 'Why, and the evidence' }).click();
  const small = await section(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('a, button, input, select')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
  );
  expect(small).toEqual([]);
  const levels = await section(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter((el) => el.getClientRects().length > 0).map((el) => Number(el.tagName[1])),
  );
  expect(levels[0]).toBe(2);
  for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
});

test('by keyboard: open the evidence, a glossary word and the list of words, and Escape returns to where you were', async ({ page }) => {
  await openProfile(page, 'light');
  const profile = section(page);
  const open = profile.getByRole('button', { name: 'Why, and the evidence' });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(profile.getByRole('heading', { name: 'The evidence' })).toBeVisible();

  const word = profile.getByRole('article', { name: 'simvastatin' }).getByRole('button', { name: 'Poor Metabolizer' });
  await word.focus();
  await page.keyboard.press('Enter');
  const drawer = page.locator('#genomic-glossary');
  await expect(drawer.getByRole('heading', { name: 'Poor Metabolizer' })).toBeFocused();
  await expect(drawer.getByText('Draft: not yet reviewed by a pharmacist.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(word).toBeFocused();

  const words = profile.getByRole('button', { name: 'Words used here' });
  await words.focus();
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('button', { name: 'Phenoconversion' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(words).toBeFocused();
});

test('"Record a decision" opens the result in the results list, and the row says the guidance is real CPIC wording', async ({ page }) => {
  await openProfile(page, 'light');
  const row = section(page).getByRole('article', { name: 'simvastatin' });
  await expect(row.getByText('Real CPIC guideline wording. Fictional patient. Not approved for clinical use.')).toBeVisible();
  await row.getByRole('button', { name: 'Why, and the evidence' }).click();
  await row.getByRole('link', { name: 'Record a decision on this result' }).click();
  await expect(page).toHaveURL(new RegExp(`\\?result=${RESULT}$`));
  await expect(page.getByRole('region', { name: 'Recorded results' })).toBeVisible();
});
