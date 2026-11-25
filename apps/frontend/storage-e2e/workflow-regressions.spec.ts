import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInAs, signInWithPatient } from '../e2e/helpers';

// Spec 052 RC1b: the four cases that attached through the chat left with it; the upload page's own suite (e2e/upload.spec.ts) proves the same
// recovery rules there. Each is named in docs/verification/2026-11-25-retire-the-chat-rc1b.md.
type Fixture = Awaited<ReturnType<typeof signInWithPatient>>;

async function reports(page: Page, fixture: Fixture) {
  const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
  expect(response.status()).toBe(200);
  return response.json();
}

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
