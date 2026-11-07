import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { DrugList } from '@telesphoros/shared-types';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';
const drugs: DrugList = JSON.parse(readFileSync(new URL('../../../packages/shared-types/src/drug-list/bundled.json', import.meta.url), 'utf8'));
const createdPatients = new WeakMap<Page, { api: string; patient: string; headers: { Authorization: string } }>();
test.afterEach(async ({ page }) => {
  const created = createdPatients.get(page);
  if (!created) return;
  const removed = await page.request.delete(`${created.api}/api/v1/patients/${created.patient}`, { headers: created.headers });
  expect(removed.status()).toBe(204);
  createdPatients.delete(page);
});

async function fixture(page: Page, earlier = 0) {
  const me = page.waitForResponse((reply) => reply.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', '/workspace');
  const auth = await me;
  const api = new URL(auth.url()).origin;
  const headers = { Authorization: auth.request().headers().authorization! };
  const label = `SYN-FILTER-${crypto.randomUUID().slice(0, 8)}`;
  const patientReply = await page.request.post(`${api}/api/v1/patients`, { headers, data: { label, requestId: crypto.randomUUID() } });
  expect(patientReply.status()).toBe(201);
  const patient = (await patientReply.json()).id as string;
  createdPatients.set(page, { api, patient, headers });
  const medicationReply = await page.request.post(`${api}/api/v1/patients/${patient}/medications`, {
    headers,
    data: { requestId: crypto.randomUUID(), rxcui: drugs.entries[0]!.rxcui, listVersion: drugs.version, status: 'active', source: 'patient-reported', startMonth: '2026-01' },
  });
  expect(medicationReply.status()).toBe(201);
  const medication = await medicationReply.json();
  const people = await page.request.get(`${api}/api/v1/followups/assignees`, { headers });
  expect(people.status()).toBe(200);
  const actor = (await people.json()).currentActor;
  let thread = '';
  for (let index = 0; index <= earlier; index++) {
    const response = await page.request.post(`${api}/api/v1/patients/${patient}/followups`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        medicationId: medication.id,
        decisionId: null,
        action: 'schedule',
        assessment: null,
        note: 'Synthetic filtered reminder',
        next: { date: index === 0 ? '2099-01-01' : '2020-01-01', timezone: 'America/Puerto_Rico', assignee: actor },
      },
    });
    expect(response.status()).toBe(201);
    if (index === 0) thread = (await response.json()).threadId;
  }
  return { patient, thread, label };
}
async function openInbox(page: Page) {
  await openWorkspaceNavigation(page);
  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  const panel = page.getByRole('dialog', { name: 'Follow-ups', exact: true });
  await expect(panel.getByText('Loading follow-ups…', { exact: true })).toHaveCount(0);
  return panel;
}
const filteredRead = (page: Page, status: string, assignment = 'mine') =>
  page.waitForResponse((reply) => {
    const url = new URL(reply.url());
    return (
      url.pathname === '/api/v1/followups' && url.searchParams.get('status') === status && url.searchParams.get('assignment') === assignment && url.searchParams.get('page') === '1'
    );
  });

test('filtering resets pagination, keeps clinic totals, handles no matches and opens the matching reminder', async ({ page }) => {
  const f = await fixture(page, 21);
  await page.getByRole('textbox', { name: 'Question' }).fill('Keep the synthetic filtered reminder discussion');
  const panel = await openInbox(page);
  let reply = filteredRead(page, 'all');
  await panel.getByRole('combobox', { name: 'Assignment', exact: true }).selectOption('mine');
  await reply;
  reply = filteredRead(page, 'overdue');
  await panel.getByLabel('Reminder status').selectOption('overdue');
  await reply;
  const totals = await panel.getByText(/^Clinic totals:/).innerText();
  const secondPage = page.waitForResponse((response) => response.url().includes('/api/v1/followups?page=2&assignment=mine&status=overdue'));
  await panel.getByRole('button', { name: 'More follow-ups', exact: true }).click();
  await secondPage;
  await expect(panel.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
  reply = filteredRead(page, 'upcoming');
  await panel.getByLabel('Reminder status').selectOption('upcoming');
  await reply;
  const target = panel.locator(`a[href="/patients/${f.patient}?followup=${f.thread}#followups"]`);
  await expect(target).toBeVisible();
  await expect(panel.getByText(/^Clinic totals:/)).toHaveText(totals);
  const previous = panel.getByRole('button', { name: 'Previous', exact: true });
  if (await previous.count()) await expect(previous).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: test.info().outputPath('filtered-reminders.png') });
  reply = filteredRead(page, 'reassignment');
  await panel.getByLabel('Reminder status').selectOption('reassignment');
  await reply;
  await expect(panel.getByText('No matching follow-ups. Try another filter or clear filters.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Assignment', exact: true })).toHaveValue('all');
  await expect(panel.getByLabel('Reminder status')).toHaveValue('all');
  reply = filteredRead(page, 'upcoming', 'all');
  await panel.getByLabel('Reminder status').selectOption('upcoming');
  await reply;
  await target.click();
  await expect(page.getByRole('form', { name: 'Document follow-up' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep the synthetic filtered reminder discussion');
});

test('a reviewer can filter clinic reminders and sees an honest empty assigned-to-me list', async ({ page, browser }) => {
  const f = await fixture(page);
  const context = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    const reviewer = await context.newPage();
    await signInAs(reviewer, 'gina', '/workspace');
    const panel = await openInbox(reviewer);
    const read = filteredRead(reviewer, 'all');
    await panel.getByRole('combobox', { name: 'Assignment', exact: true }).selectOption('mine');
    await read;
    await expect(panel.getByText('No matching follow-ups. Try another filter or clear filters.', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
    const all = filteredRead(reviewer, 'upcoming', 'all');
    await panel.getByLabel('Reminder status').selectOption('upcoming');
    await all;
    await panel.locator(`a[href="/patients/${f.patient}?followup=${f.thread}#followups"]`).click();
    const selected = reviewer.getByRole('region', { name: 'Selected follow-up' });
    await expect(selected).toBeVisible();
    await expect(selected.getByRole('form')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('changing filters discards an obsolete response and retries the current selection after a read failure', async ({ page }) => {
  const f = await fixture(page);
  const panel = await openInbox(page);
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let fail = true;
  await page.route('**/api/v1/followups?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('status') === 'overdue') {
      const response = await route.fetch();
      reached();
      await blocked;
      await route.fulfill({ response }).catch(() => undefined); // The obsolete browser request may already be aborted.
    } else if (url.searchParams.get('status') === 'upcoming' && fail) {
      fail = false;
      await route.fulfill({ status: 503, body: '{}' });
    } else await route.continue();
  });
  try {
    await panel.getByLabel('Reminder status').selectOption('overdue');
    await started;
    await expect(panel.getByText('Loading follow-ups…', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link')).toHaveCount(0);
    await panel.getByLabel('Reminder status').selectOption('upcoming');
    await expect(panel.getByRole('alert')).toContainText('Follow-ups could not be loaded');
    release();
    await panel.getByRole('button', { name: 'Retry follow-ups', exact: true }).click();
    await expect(panel.locator(`a[href="/patients/${f.patient}?followup=${f.thread}#followups"]`)).toBeVisible();
    await expect(panel.getByLabel('Reminder status')).toHaveValue('upcoming');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  } finally {
    release();
  }
});
