import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { DrugList } from '@telesphoros/shared-types';
const BUNDLED_DRUG_LIST: DrugList = JSON.parse(readFileSync(new URL('../../../packages/shared-types/src/drug-list/bundled.json', import.meta.url), 'utf8'));
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

async function fixture(page: Page, count = 1) {
  const me = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', '/workspace');
  const auth = await me;
  const api = new URL(auth.url()).origin;
  const headers = { Authorization: auth.request().headers().authorization! };
  const label = `SYN-DIRECT-${crypto.randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${api}/api/v1/patients`, { headers, data: { label, requestId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const patient = (await created.json()).id as string;
  const drug = BUNDLED_DRUG_LIST!.entries[0]!;
  const medicationReply = await page.request.post(`${api}/api/v1/patients/${patient}/medications`, {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      rxcui: drug.rxcui,
      listVersion: BUNDLED_DRUG_LIST!.version,
      status: 'active',
      source: 'patient-reported',
      startMonth: '2026-01',
    },
  });
  expect(medicationReply.status()).toBe(201);
  const medication = await medicationReply.json();
  const people = await page.request.get(`${api}/api/v1/followups/assignees`, { headers });
  const actor = (await people.json()).currentActor;
  const payload = {
    requestId: crypto.randomUUID(),
    medicationId: medication.id,
    decisionId: null,
    action: 'schedule',
    assessment: null,
    note: 'Synthetic selected follow-up goal',
    next: { date: '2099-12-31', timezone: 'America/Puerto_Rico', assignee: actor },
  };
  const first = await page.request.post(`${api}/api/v1/patients/${patient}/followups`, { headers, data: payload });
  expect(first.status()).toBe(201);
  const target = await first.json();
  for (let index = 1; index < count; index++) {
    const another = await page.request.post(`${api}/api/v1/patients/${patient}/followups`, {
      headers,
      data: { ...payload, requestId: crypto.randomUUID(), next: { ...payload.next, date: '2099-01-01' } },
    });
    expect(another.status()).toBe(201);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/workspace');
  return { api, headers, patient, target, payload, medication, label };
}
async function openTarget(page: Page, patient: string, thread: string, label: string) {
  await openWorkspaceNavigation(page);
  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  const panel = page.getByRole('dialog', { name: 'Follow-ups', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Loading follow-ups…', { exact: true })).toHaveCount(0);
  const target = panel.getByRole('link', { name: `Open follow-up for ${label}`, exact: true }).and(page.locator(`[href="/patients/${patient}?followup=${thread}#followups"]`));
  for (let index = 0; index < 10 && !(await target.count()); index++) {
    const next = panel.getByRole('button', { name: 'More follow-ups', exact: true });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await expect(next).toBeEnabled();
    const response = page.waitForResponse((reply) => /\/api\/v1\/followups\?page=/.test(reply.url()));
    await next.click();
    await response;
    await expect(panel.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
  }
  await expect(target).toBeVisible();
  await target.click();
}

test('a reminder opens its latest form beyond page one and saves only the selected thread', async ({ page }) => {
  const f = await fixture(page, 21);
  await page.getByRole('textbox', { name: 'Question' }).fill('Keep the synthetic direct-entry discussion');
  const firstPage = await page.request.get(`${f.api}/api/v1/patients/${f.patient}/followups?page=1`, { headers: f.headers });
  expect((await firstPage.json()).items.some((entry: { threadId: string }) => entry.threadId === f.target.threadId)).toBe(false);
  const changed = await page.request.post(`${f.api}/api/v1/patients/${f.patient}/followups`, {
    headers: f.headers,
    data: { ...f.payload, requestId: crypto.randomUUID(), threadId: f.target.threadId, expectedVersion: 1, action: 'reschedule', note: 'Synthetic visit moved' },
  });
  expect(changed.status()).toBe(201);
  await openTarget(page, f.patient, f.target.threadId, f.label);
  const section = page.getByRole('region', { name: 'Selected follow-up' });
  const form = section.getByRole('form', { name: 'Document follow-up' });
  await expect(form).toBeVisible();
  await expect(section.getByText(`${f.label} · ${f.medication.name}`, { exact: true })).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Recorded medication' })).toHaveValue(f.medication.id);
  await form.getByLabel('Follow-up note').fill('Synthetic direct-entry documentation');
  await form.getByRole('combobox', { name: 'Follow-up plan' }).selectOption('none');
  expect(await axeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.screenshot({ path: test.info().outputPath('direct-followup-form.png') });
  await section.screenshot({ path: test.info().outputPath('selected-followup.png') });
  await form.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/patients/${f.patient}#followups$`));
  await expect(page.getByText('Follow-up saved.', { exact: true })).toBeVisible();
  const history = await page.request.get(`${f.api}/api/v1/patients/${f.patient}/followups?threadId=${f.target.threadId}`, { headers: f.headers });
  expect((await history.json()).items[0]).toMatchObject({ threadId: f.target.threadId, version: 3, note: 'Synthetic direct-entry documentation', next: null });
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep the synthetic direct-entry discussion');
});

async function visitBookmark(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected follow-up' })).toBeVisible();
}

test('a closed reminder opens its current record without a documentation form or a write', async ({ page }) => {
  const f = await fixture(page);
  const dismissed = await page.request.post(`${f.api}/api/v1/patients/${f.patient}/followups`, {
    headers: f.headers,
    data: {
      ...f.payload,
      requestId: crypto.randomUUID(),
      threadId: f.target.threadId,
      expectedVersion: 1,
      action: 'dismiss',
      next: null,
      note: 'Synthetic reminder closed',
    },
  });
  expect(dismissed.status()).toBe(201);
  await visitBookmark(page, `/patients/${f.patient}?keep=demo&followup=${f.target.threadId}`);
  const section = page.getByRole('region', { name: 'Selected follow-up' });
  await expect(section.getByText('This reminder is closed.', { exact: true })).toBeVisible();
  await expect(section.getByRole('form')).toHaveCount(0);
  await section.getByRole('button', { name: 'History', exact: true }).click();
  await expect(section.getByRole('list', { name: 'Follow-up history' }).getByText('Version 2 · dismiss')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await section.screenshot({ path: test.info().outputPath('closed-followup.png') });
  await section.getByRole('button', { name: 'Return to follow-ups' }).click();
  await expect(page).toHaveURL(new RegExp(`/patients/${f.patient}\\?keep=demo#followups$`));
  const history = await page.request.get(`${f.api}/api/v1/patients/${f.patient}/followups?threadId=${f.target.threadId}`, { headers: f.headers });
  expect((await history.json()).items).toHaveLength(2);
});

test('a reviewer can open the selected record and history without a write form', async ({ page, browser }, info) => {
  const f = await fixture(page);
  const review = await browser.newPage({ viewport: page.viewportSize()!, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile });
  try {
    await signInAs(review, 'gina', `/patients/${f.patient}?followup=${f.target.threadId}`);
    const section = review.getByRole('region', { name: 'Selected follow-up' });
    await expect(section.getByText('Synthetic selected follow-up goal')).toBeVisible();
    await expect(section.getByRole('form')).toHaveCount(0);
    await section.getByRole('button', { name: 'History', exact: true }).click();
    await expect(section.getByRole('list', { name: 'Follow-up history' }).getByText('Version 1 · schedule')).toBeVisible();
    expect(await axeViolations(review)).toEqual([]);
    await section.getByRole('button', { name: 'Return to follow-ups' }).click();
    await expect(review.getByRole('button', { name: 'Document follow-up', exact: true })).toHaveCount(0);
  } finally {
    await review.close();
  }
});

test('a concurrent change refuses the stale save and retains the physician draft until cancel', async ({ page }) => {
  const f = await fixture(page);
  await openTarget(page, f.patient, f.target.threadId, f.label);
  const form = page.getByRole('form', { name: 'Document follow-up' });
  await form.getByLabel('Follow-up note').fill('Keep this synthetic draft after a concurrent change');
  await form.getByRole('combobox', { name: 'Follow-up plan' }).selectOption('none');
  const changed = await page.request.post(`${f.api}/api/v1/patients/${f.patient}/followups`, {
    headers: f.headers,
    data: {
      ...f.payload,
      requestId: crypto.randomUUID(),
      threadId: f.target.threadId,
      expectedVersion: 1,
      action: 'reschedule',
      next: { ...f.payload.next, date: '2099-12-30' },
    },
  });
  expect(changed.status()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await form.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('This follow-up changed. Your draft is kept.');
  await expect(form.getByLabel('Follow-up note')).toHaveValue('Keep this synthetic draft after a concurrent change');
  const history = await page.request.get(`${f.api}/api/v1/patients/${f.patient}/followups?threadId=${f.target.threadId}`, { headers: f.headers });
  expect((await history.json()).items).toHaveLength(2);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/patients/${f.patient}#followups$`));
  await expect(page.getByText('Next follow-up: 2099-12-30 (America/Puerto_Rico)', { exact: true })).toBeVisible();
});

test('a failed selected-record read can retry without opening a different follow-up', async ({ page }) => {
  const f = await fixture(page);
  let reads = 0;
  await page.route(`**/api/v1/patients/${f.patient}/followups?*threadId=${f.target.threadId}`, async (route) => {
    reads++;
    if (reads === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    else await route.continue();
  });
  await openTarget(page, f.patient, f.target.threadId, f.label);
  const section = page.getByRole('region', { name: 'Selected follow-up' });
  await expect(section.getByRole('alert')).toHaveText('This follow-up could not be loaded. Please retry.');
  await expect(section.getByRole('form')).toHaveCount(0);
  await section.getByRole('button', { name: 'Retry selected follow-up' }).click();
  await expect(section.getByRole('form', { name: 'Document follow-up' })).toBeVisible();
  expect(reads).toBe(2);
});

test('malformed and other-patient links do not open a documentation form', async ({ page }) => {
  const f = await fixture(page);
  await visitBookmark(page, `/patients/${f.patient}?followup=invalid`);
  const section = page.getByRole('region', { name: 'Selected follow-up' });
  await expect(section.getByRole('alert')).toHaveText('That follow-up link is invalid.');
  await expect(section.getByRole('form')).toHaveCount(0);
  const another = await page.request.post(`${f.api}/api/v1/patients`, {
    headers: f.headers,
    data: { label: `SYN-OTHER-${crypto.randomUUID().slice(0, 8)}`, requestId: crypto.randomUUID() },
  });
  expect(another.status()).toBe(201);
  const otherId = (await another.json()).id;
  await visitBookmark(page, `/patients/${otherId}?followup=${f.target.threadId}`);
  await expect(section.getByRole('alert')).toHaveText('This follow-up is not available for this patient.');
  await expect(section.getByRole('form')).toHaveCount(0);
  await section.getByRole('button', { name: 'Return to follow-ups' }).click();
  await expect(page.getByRole('region', { name: 'Follow-up', exact: true }).getByText('No follow-ups recorded yet.')).toBeVisible();
});
