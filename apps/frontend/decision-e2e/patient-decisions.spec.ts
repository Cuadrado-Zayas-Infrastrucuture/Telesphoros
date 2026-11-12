import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInAs, axeViolations } from '../e2e/helpers';
const fixtures = JSON.parse(readFileSync(process.env.DECISION_FIXTURES!, 'utf8')) as Record<
  string,
  { patient: string; evaluation: string; result: string; drug: string; medication: string }
>;

test('a stored result records a decision and schedules a linked follow-up', async ({ page }) => {
  const f = fixtures[`${test.info().project.name}:decision`]!;
  const me = page.waitForResponse((reply) => reply.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', `/patients/${f.patient}`);
  const auth = await me;
  const api = new URL(auth.url()).origin;
  const headers = { Authorization: auth.request().headers().authorization! };
  // Specs/038 D4: the stored results and a current recommendation's decision controls are on the page without a click.
  const result = page.getByRole('region', { name: `Stored result ${f.drug}` }).first();
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'Record decision', exact: true }).click();
  const form = result.getByRole('form', { name: 'Record decision' });
  await form.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('modified');
  await form.getByLabel('Different dose, frequency or duration', { exact: true }).check();
  await form.getByRole('textbox', { name: 'Decision note', exact: true }).fill('Synthetic documentation of a planned dose change.');
  let drop = true;
  await page.route(`**/api/v1/evaluation-results/${f.result}/clinician-decisions`, async (route) => {
    if (route.request().method() === 'POST' && drop) {
      drop = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.fulfill({ status: 503, body: '{}' });
    } else await route.continue();
  });
  await form.getByRole('button', { name: 'Save decision', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('not confirmed');
  await expect(form.getByRole('textbox', { name: 'Decision note', exact: true })).toHaveValue('Synthetic documentation of a planned dose change.');
  await form.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(result.getByText('Decision saved.', { exact: true })).toBeVisible();
  const historyReply = await page.request.get(`${api}/api/v1/evaluation-results/${f.result}/clinician-decisions`, { headers });
  expect(historyReply.status()).toBe(200);
  const history = await historyReply.json();
  expect(history.entries).toHaveLength(1);
  expect(history.entries[0]).toMatchObject({ response: 'modified', detailCodes: ['change-dose'], patientId: f.patient });
  await result.getByRole('button', { name: 'Correct decision', exact: true }).click();
  const correction = result.getByRole('form', { name: 'Correct decision' });
  await correction.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('accepted');
  await correction.getByRole('textbox', { name: 'Decision note', exact: true }).fill('Synthetic correction: acceptance was intended.');
  await correction.getByRole('button', { name: 'Save decision', exact: true }).click();
  await expect(result.getByText('Current decision: Accepted', { exact: true })).toBeVisible();
  await result.getByRole('button', { name: 'Decision history (2)', exact: true }).click();
  await expect(result.getByText('Synthetic documentation of a planned dose change.', { exact: true })).toBeVisible();
  await expect(result.getByText('Synthetic correction: acceptance was intended.', { exact: true })).toBeVisible();
  await result.screenshot({ path: test.info().outputPath('decision-history.png') });
  await result.getByRole('button', { name: 'Schedule linked follow-up', exact: true }).click();
  const followup = page.getByRole('form', { name: 'Schedule follow-up' });
  await expect(followup.getByText(/Linked decision:/)).toBeVisible();
  await followup.getByRole('combobox', { name: 'Recorded medication', exact: true }).selectOption(f.medication);
  await followup.getByRole('textbox', { name: 'Reason or treatment goal' }).fill('Synthetic check after the documented decision.');
  await followup.getByLabel('Next follow-up date').fill('2099-02-01');
  expect(await axeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await followup.screenshot({ path: test.info().outputPath('decision-linked-followup.png') });
  await followup.getByRole('button', { name: 'Schedule follow-up', exact: true }).click();
  await expect(page.getByText('Follow-up saved.', { exact: true })).toBeVisible();
  const saved = await page.request.get(`${api}/api/v1/patients/${f.patient}/followups`, { headers });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).items[0]).toMatchObject({ decisionId: history.currentDecisionId, medicationId: f.medication });
  await result.getByRole('button', { name: 'Withdraw entry', exact: true }).click();
  await result.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(result.getByText('Current decision: Modified', { exact: true })).toBeVisible();
  const afterWithdrawal = await page.request.get(`${api}/api/v1/evaluation-results/${f.result}/clinician-decisions`, { headers });
  expect((await afterWithdrawal.json()).entries).toHaveLength(3);
});

test('a changed decision head refuses the stale save and preserves the physician draft', async ({ page }) => {
  const f = fixtures[`${test.info().project.name}:conflict`]!;
  const me = page.waitForResponse((reply) => reply.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', `/patients/${f.patient}`);
  const auth = await me;
  const api = new URL(auth.url()).origin;
  const headers = { Authorization: auth.request().headers().authorization! };
  const result = page.getByRole('region', { name: `Stored result ${f.drug}` }).first();
  await result.getByRole('button', { name: 'Record decision', exact: true }).click();
  const form = result.getByRole('form', { name: 'Record decision' });
  await form.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('accepted');
  await form.getByRole('textbox', { name: 'Decision note', exact: true }).fill('Keep this synthetic decision draft.');
  const competing = await page.request.post(`${api}/api/v1/evaluation-results/${f.result}/clinician-decisions`, {
    headers,
    data: { requestId: crypto.randomUUID(), evaluationId: f.evaluation, patientId: f.patient, entryKind: 'decision', previousEntryId: null, response: 'accepted' },
  });
  expect(competing.status()).toBe(201);
  await form.getByRole('button', { name: 'Save decision', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('changed');
  await expect(form.getByRole('textbox', { name: 'Decision note', exact: true })).toHaveValue('Keep this synthetic decision draft.');
  const history = await page.request.get(`${api}/api/v1/evaluation-results/${f.result}/clinician-decisions`, { headers });
  expect((await history.json()).entries).toHaveLength(1);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(result.getByText('Current decision: Accepted', { exact: true })).toBeVisible();
});

test('a retracted stored result cannot offer a new decision', async ({ page }) => {
  const f = fixtures[`${test.info().project.name}:held`]!;
  await signInAs(page, 'alice', `/patients/${f.patient}`);
  const result = page.getByRole('region', { name: `Stored result ${f.drug}` }).first();
  // Specs/038 D4, D7: a result that is not current is never opened for the reader. Its row says so; opened, it says that no decision can
  // be recorded, and only its history is behind a further click.
  await result.getByRole('button', { name: /: not current, / }).click();
  await expect(result.getByText('This is not the current result, so no new decision can be recorded on it.', { exact: true })).toBeVisible();
  await result.getByRole('button', { name: 'Decision history', exact: true }).click();
  await expect(result.getByText(/New decisions are unavailable/)).toBeVisible();
  await expect(result.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await expect(result.getByRole('form')).toHaveCount(0);
});

test('a reviewer can inspect decision history without write controls', async ({ page }) => {
  const f = fixtures[`${test.info().project.name}:reviewer`]!;
  await signInAs(page, 'gina', `/patients/${f.patient}`);
  const result = page.getByRole('region', { name: `Stored result ${f.drug}` }).first();
  await expect(result.getByText('No decisions recorded.', { exact: true })).toBeVisible();
  await expect(result.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await expect(result.getByRole('form')).toHaveCount(0);
});

test('a temporary read failure stays distinct from disabled processing and can retry', async ({ page }) => {
  const f = fixtures[`${test.info().project.name}:reviewer`]!;
  // The results are read with the page (specs/038 D4), so the failing read is arranged before the page opens.
  let fail = true;
  await page.route('**/api/v1/evaluations?*', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE' } }) });
    } else await route.continue();
  });
  await signInAs(page, 'alice', `/patients/${f.patient}`);
  const section = page.getByRole('region', { name: 'Recorded results', exact: true });
  await expect(section.getByRole('alert')).toHaveText('Stored results could not be loaded. Please retry.');
  await section.getByRole('button', { name: 'Retry stored results', exact: true }).click();
  await expect(section.getByRole('region', { name: `Stored result ${f.drug}` }).first()).toBeVisible();
  await expect(section.getByRole('alert')).toHaveCount(0);
});
