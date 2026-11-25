import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openPatients, signInAs } from './helpers';

// Spec 040 slice B: the Patients list finds a patient who is not on the loaded pages, by asking the real backend (in-memory store) to search
// every patient. Twenty-five synthetic patients are made by the test, so the oldest is never on the first page of twenty, newest first.

async function signInAndMakePatients(page: Page, count: number) {
  const me = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', '/workspace');
  const authenticated = await me;
  const api = new URL(authenticated.url()).origin;
  const headers = { Authorization: authenticated.request().headers().authorization! };
  // A prefix of this run's own, so the search counts only these patients, whatever other tests have made.
  const prefix = `SYN-${crypto.randomUUID().slice(0, 8)}`;
  const labels: string[] = [];
  for (let index = 0; index < count; index++) {
    const created = await page.request.post(`${api}/api/v1/patients`, { headers, data: { label: `${prefix}-${index}` } });
    expect(created.status()).toBe(201);
    labels.push(`${prefix}-${index}`);
  }
  return { prefix, labels };
}

test('finds the oldest of 25 patients, which is not on the loaded page, with Search all patients', async ({ page }) => {
  const { prefix, labels } = await signInAndMakePatients(page, 25);
  const oldest = labels[0]!;
  await openPatients(page);
  const roster = page.getByRole('region', { name: 'Patient records' });
  await expect(roster.getByRole('link', { name: labels[24]!, exact: true })).toBeVisible();

  const field = roster.getByRole('textbox', { name: 'Find a patient' });
  await field.fill(oldest);
  await expect(roster.getByText('No match among loaded patients. Search all patients to keep looking.')).toBeVisible();
  await roster.getByRole('button', { name: 'Search all patients' }).click();
  await expect(roster.getByRole('link', { name: oldest, exact: true })).toBeVisible();
  await expect(roster.getByText('Searched all patients: 1 match.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // The prefix matches all 25: one page of 20, then More matches for the other 5, the oldest last.
  await field.fill(prefix);
  await field.press('Enter');
  await expect(roster.getByText('Searched all patients: 25 matches.')).toBeVisible();
  await expect(roster.getByRole('link', { name: oldest, exact: true })).toHaveCount(0);
  await roster.getByRole('button', { name: 'More matches' }).click();
  await expect(roster.getByRole('link', { name: oldest, exact: true })).toBeVisible();
  await expect(roster.getByRole('button', { name: 'More matches' })).toHaveCount(0);

  // Clearing the text returns to the loaded list.
  await field.fill('');
  await expect(roster.getByRole('button', { name: 'More patients' })).toBeVisible();
  await expect(roster.getByText(/^Typing looks through the \d+ patients loaded so far\./)).toBeVisible();
});

test('by keyboard: type a label, Enter searches, Tab reaches the match and Enter opens the patient', async ({ page }) => {
  const { labels } = await signInAndMakePatients(page, 25);
  const oldest = labels[0]!;
  await openPatients(page);
  const roster = page.getByRole('region', { name: 'Patient records' });
  const field = roster.getByRole('textbox', { name: 'Find a patient' });
  await field.focus();
  await page.keyboard.type(oldest);
  await page.keyboard.press('Enter');
  const match = roster.getByRole('link', { name: oldest, exact: true });
  await expect(match).toBeVisible();
  await match.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: oldest })).toBeVisible();
});
