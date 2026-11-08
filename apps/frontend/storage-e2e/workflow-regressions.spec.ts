import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInAs, signInWithPatient } from '../e2e/helpers';

const sample = { name: 'synthetic-workflow.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') };
type Fixture = Awaited<ReturnType<typeof signInWithPatient>>;

async function attachInChat(page: Page, fixture: Fixture) {
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'New chat', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(sample);
  const details = page.getByRole('dialog', { name: 'Report details', exact: true });
  await details.getByRole('combobox', { name: 'Patient', exact: true }).selectOption(fixture.id);
  await details.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  return details;
}

async function reports(page: Page, fixture: Fixture) {
  const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
  expect(response.status()).toBe(200);
  return response.json();
}

test('chat retries lost registration, declaration and committed-byte replies as one upload', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const registrationKeys: string[] = [];
  let declarations = 0;
  let transfers = 0;
  for (const suffix of ['reports', 'reports/*/upload-attempts', 'reports/*/upload-attempts/*/bytes']) {
    await page.route(`**/api/v1/${suffix}`, async (route) => {
      if (!['POST', 'PUT'].includes(route.request().method())) return route.continue();
      let lose: boolean;
      if (suffix === 'reports') {
        registrationKeys.push(route.request().postDataJSON().requestId);
        lose = registrationKeys.length === 1;
      } else if (suffix.endsWith('bytes')) {
        transfers++;
        lose = true;
      } else lose = ++declarations === 1;
      if (!lose) return route.continue();
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort('failed');
    });
  }
  const details = await attachInChat(page, fixture);
  for (let retry = 0; retry < 3; retry++) {
    await details.getByRole('button', { name: 'Upload report', exact: true }).click();
    await expect(details.getByRole('alert')).toBeVisible();
    expect((await reports(page, fixture)).meta.total).toBe(1);
  }
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true })).toBeVisible();
  const stored = await reports(page, fixture);
  expect(stored.meta.total).toBe(1);
  expect(stored.data).toMatchObject([{ fileUploaded: true, filename: sample.name }]);
  expect(registrationKeys).toHaveLength(2);
  expect(new Set(registrationKeys).size).toBe(1);
  expect(transfers).toBe(1);
});

test('chat checks the known report after twenty older reports', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  for (let index = 0; index < 20; index++) {
    const registered = await page.request.post(`${fixture.api}/api/v1/reports`, {
      headers: fixture.headers,
      data: { patientId: fixture.id, type: 'structured', filename: `older-${index}.json`, sizeBytes: 2 },
    });
    expect(registered.status()).toBe(201);
  }
  const details = await attachInChat(page, fixture);
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation.getByRole('button', { name: 'Check status', exact: true })).toBeVisible();
  await expect(conversation).not.toContainText('This report is not in the latest list yet.');
  await conversation.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(conversation.getByRole('button', { name: 'Check status', exact: true })).toBeVisible();
  await expect(conversation).not.toContainText('This report is not in the latest list yet.');
  await expect(conversation).not.toContainText('The status could not be loaded.');
  await expect(conversation.getByText('Received', { exact: true })).toBeVisible();
  expect((await reports(page, fixture)).meta.total).toBe(21);
});

test('a completed chat upload allows an intentional second upload of the same file', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const details = await attachInChat(page, fixture);
  const received = page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true });
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(received).toHaveCount(1);
  await page.locator('input[type=file]').setInputFiles(sample);
  await details.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(received).toHaveCount(2);
  const stored = await reports(page, fixture);
  expect(stored.meta.total).toBe(2);
  expect(new Set(stored.data.map((report: { id: string }) => report.id)).size).toBe(2);
  expect(stored.data.every((report: { fileUploaded: boolean }) => report.fileUploaded)).toBe(true);
});

test('changing a failed chat attachment keeps cancellation available before starting another upload', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', (route) => route.abort('failed'));
  const details = await attachInChat(page, fixture);
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(details.getByRole('alert')).toBeVisible();
  const replacement = { ...sample, name: 'synthetic-replacement.json', buffer: Buffer.from('{"synthetic":"replacement"}') };
  await page.locator('input[type=file]').setInputFiles(replacement);
  await details.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText('Cancel the previous upload');
  expect((await reports(page, fixture)).meta.total).toBe(1);
  await details.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(details).not.toBeVisible();
  expect((await reports(page, fixture)).meta.total).toBe(0);
  await page.unroute('**/api/v1/reports/*/upload-attempts/*/bytes');
  await page.locator('input[type=file]').setInputFiles(replacement);
  await details.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true })).toBeVisible();
  const stored = await reports(page, fixture);
  expect(stored.meta.total).toBe(1);
  expect(stored.data).toMatchObject([{ filename: replacement.name, fileUploaded: true }]);
});

test('merged patient report history and stage counts include original patient IDs and separate again on unmerge', async ({ page, browser }) => {
  const survivor = await signInWithPatient(page);
  const create = async () => {
    const response = await page.request.post(`${survivor.api}/api/v1/patients`, {
      headers: survivor.headers,
      data: { label: `SYN-${crypto.randomUUID()}` },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const source = await create();
  const unrelated = await create();
  const filenames = ['survivor-history.json', 'source-history.json', 'unrelated-history.json'];
  for (const [index, patientId] of [survivor.id, source.id, unrelated.id].entries()) {
    const response = await page.request.post(`${survivor.api}/api/v1/reports`, {
      headers: survivor.headers,
      data: { patientId, type: 'structured', filename: filenames[index], sizeBytes: 2 },
    });
    expect(response.status()).toBe(201);
  }
  const reviewer = await browser.newContext();
  try {
    const reviewerPage = await reviewer.newPage();
    const authenticated = reviewerPage.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
    await signInAs(reviewerPage, 'gina', '/workspace');
    const reviewerHeaders = { Authorization: (await authenticated).request().headers().authorization! };
    async function decide(kind: 'merge' | 'unmerge') {
      const proposal = await page.request.post(`${survivor.api}/api/v1/patient-merges`, {
        headers: survivor.headers,
        data: { kind, sourcePatientId: source.id, targetPatientId: survivor.id, reasonCode: kind === 'merge' ? 'entered-twice' : 'merged-by-mistake' },
      });
      expect(proposal.status()).toBe(201);
      const decision = await reviewerPage.request.post(`${survivor.api}/api/v1/patient-merges/${(await proposal.json()).id}/decision`, {
        headers: reviewerHeaders,
        data: { decision: 'approved' },
      });
      expect(decision.status()).toBe(201);
    }
    await decide('merge');
    const grouped = await reports(page, survivor);
    expect(grouped.meta.total).toBe(2);
    expect(grouped.data.map((report: { patientId: string }) => report.patientId).sort()).toEqual([source.id, survivor.id].sort());
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Reports', exact: true }).click();
    await selectReportsPatient(page, survivor);
    await expect(page.getByRole('button', { name: /^Open (survivor|source)-history.json/ })).toHaveCount(2);
    await expect(page.getByRole('button', { name: /^Open unrelated-history.json/ })).toHaveCount(0);
    const stages = page.getByRole('region', { name: 'Report stages', exact: true });
    await expect(stages.getByRole('definition')).toHaveText(['2 100%', '0 0%', '0 0%']);
    await decide('unmerge');
    await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Open survivor-history.json/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Open source-history.json/ })).toHaveCount(0);
    await expect(stages.getByRole('definition')).toHaveText(['1 100%', '0 0%', '0 0%']);
  } finally {
    await reviewer.close();
  }
});
