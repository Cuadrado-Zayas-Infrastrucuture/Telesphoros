import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from '../e2e/helpers';
const require = createRequire(import.meta.url);
const id = '11111111-1111-4111-8111-111111111111';

test('review list pages support keyboard navigation and preserve their position after refusal', async ({ page }) => {
  let failNext = true;
  const requests: string[] = [];
  for (const endpoint of ['evaluations', 'cell-disputes']) {
    await page.route(`**/api/v1/${endpoint}?*`, (route) => {
      const url = new URL(route.request().url());
      const current = Number(url.searchParams.get('page'));
      requests.push(`${endpoint}:${current}`);
      if (endpoint === 'evaluations' && current === 2 && failNext) {
        failNext = false;
        return route.fulfill({ status: 503, json: {} });
      }
      return route.fulfill({ json: { data: [], meta: { page: current, pageSize: 20, total: 21, totalPages: 2 } } });
    });
  }
  await signInAs(page, 'gina', '/local-operations');
  await page.getByRole('button', { name: 'Refresh evaluations' }).click();
  const nav = page.getByRole('navigation', { name: 'Evaluation pages' });
  await expect(nav).toContainText('Page 1 of 2');
  await nav.getByRole('button', { name: 'Next evaluation page' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Request refused');
  await expect(nav).toContainText('Page 1 of 2');
  await nav.getByRole('button', { name: 'Next evaluation page' }).focus();
  await page.keyboard.press('Enter');
  await expect(nav).toContainText('Page 2 of 2');
  await expect(nav.getByRole('button', { name: 'Next evaluation page' })).toBeDisabled();
  await nav.getByRole('button', { name: 'Previous evaluation page' }).focus();
  await page.keyboard.press('Enter');
  await expect(nav).toContainText('Page 1 of 2');
  await page.getByRole('button', { name: 'Refresh disputes' }).click();
  const disputes = page.getByRole('navigation', { name: 'Dispute pages' });
  await disputes.getByRole('button', { name: 'Next dispute page' }).focus();
  await page.keyboard.press('Enter');
  await expect(disputes).toContainText('Page 2 of 2');
  expect(requests).toEqual(['evaluations:1', 'evaluations:2', 'evaluations:2', 'evaluations:1', 'cell-disputes:1', 'cell-disputes:2']);
  await accessible(page);
});
async function accessible(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected for this test only
    const result = await window.axe.run(document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'],
    });
    return result.violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const small = await page
    .locator(
      'main button, main input:not([type=checkbox]), main select, main textarea, main a',
    )
    .evaluateAll((elements) =>
      elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.height < 43.5;
        })
        .map((el) => el.textContent),
    );
  expect(small).toEqual([]);
}
for (const path of ['/local-upload', '/local-review', '/local-operations']) {
  test(`${path} fits mobile and desktop and is accessible`, async ({
    page,
  }) => {
    await signInAs(page, 'gina', path);
    await accessible(page);
  });
}
test('capture validation is field-linked and keyboard usable', async ({
  page,
}) => {
  await signInAs(page, 'gina', '/local-review');
  await page.getByRole('button', { name: 'Open capture' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Capture ID')).toBeFocused();
  await expect(page.getByLabel('Capture ID')).toHaveAccessibleDescription(
    'Enter a valid capture ID.',
  );
  await accessible(page);
  await page.getByRole('button', { name: 'Upload and capture' }).click();
  await expect(page.getByLabel('Synthetic label')).toBeFocused();
  await accessible(page);
});
test('source text stays exact, long values stay contained, and decision needs comparison', async ({
  page,
}) => {
  const text = 'SYNTHETIC ' + 'X'.repeat(600) + '\n*1/*Z';
  await page.route('**/api/v1/captures/' + id, (route) =>
    route.fulfill({
      json: {
        id,
        reportId: id,
        pdfSha256: 'a'.repeat(64),
        textSha256: 'b'.repeat(64),
        textScalars: text.length,
        popplerVersion: '26.03.0',
        runner: 'fake',
        createdAt: 'now',
        latestDecision: null,
      },
    }),
  );
  await page.route('**/api/v1/**-url', (route) =>
    route.fulfill({
      json: {
        url: 'http://127.0.0.1:5555/fixture',
        expiresAt: '2026-10-09T00:00:00Z',
      },
    }),
  );
  await page.route('http://127.0.0.1:5555/fixture', (route) =>
    route.fulfill({
      body: text,
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  await signInAs(page, 'gina', '/local-review');
  await page.getByLabel('Capture ID').fill(id);
  await page.getByRole('button', { name: 'Open capture', exact: true }).click();
  await expect(page.locator('pre')).toHaveText(text);
  expect(await page.locator('pre').textContent()).toBe(text);
  await expect(
    page.getByRole('button', { name: 'Accept capture' }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I compared the PDF and stored text, including field associations',
    )
    .focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Accept capture' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Run synthetic evaluation' }),
  ).toBeDisabled();
  await accessible(page);
});
test('dispute validation preserves inputs and directs focus without a write', async ({
  page,
}) => {
  let writes = 0;
  await page.route('**/api/v1/cell-disputes', (route) => {
    writes++;
    return route.fulfill({ status: 503, json: {} });
  });
  await signInAs(page, 'gina', '/local-operations');
  await page
    .getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    )
    .check();
  await page.getByRole('button', { name: 'Raise dispute' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Guideline ID')).toBeFocused();
  expect(writes).toBe(0);
  await accessible(page);
  for (const [label, value] of [
    ['Guideline ID', 'synthetic-guideline'],
    ['Table', 'Table 1'],
    ['Row', 'Normal'],
    ['Synthetic note or decision evidence', 'Synthetic evidence'],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    )
    .check();
  await page.getByRole('button', { name: 'Raise dispute' }).click();
  await expect(page.getByRole('alert')).toContainText('Request refused');
  await expect(page.getByLabel('Guideline ID')).toHaveValue(
    'synthetic-guideline',
  );
  expect(writes).toBe(1);
  await accessible(page);
});

test('evaluation history scrolls inside its region and correction errors are field-linked', async ({
  page,
}) => {
  const summary = {
    id,
    reportId: id,
    patientId: id,
    captureId: id,
    acceptance: null,
    disposition: 'held',
    holdCode: 'unsupported-layout',
    hold: { message: 'Synthetic hold', reviewerAction: 'Review' },
    knowledgeSetId: 'K'.repeat(600),
    engineVersion: 'test',
    scope: null,
    clinicalUse: 'not-approved',
    state: 'active',
    supersededBy: null,
    results: [],
    geneStates: [],
    corrections: [],
    current: true,
    advisory: { activeDisputes: 0, patientLink: 'verified' },
    actionable: false,
    createdAt: 'now',
  };
  await page.route('**/api/v1/evaluations?*', (route) =>
    route.fulfill({ json: { data: [summary], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } } }),
  );
  await page.route('**/api/v1/evaluations/' + id, (route) =>
    route.fulfill({ json: { ...summary, geneInputs: [] } }),
  );
  await signInAs(page, 'gina', '/local-operations');
  await page.getByRole('button', { name: 'Refresh evaluations' }).click();
  await page.getByRole('button', { name: 'Open ' + id, exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Correction', exact: true })
    .selectOption('supersession');
  await page
    .getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    )
    .check();
  await page.getByRole('button', { name: 'Record correction' }).click();
  await expect(
    page.getByLabel('Replacement evaluation ID'),
  ).toHaveAccessibleDescription('Enter a valid replacement evaluation ID.');
  await expect(page.getByLabel('Replacement evaluation ID')).toBeFocused();
  await accessible(page);
  await page.getByRole('region', { name: 'Evaluation history table' }).focus();
  await expect(
    page.getByRole('region', { name: 'Evaluation history table' }),
  ).toBeFocused();
});

test('dispute decisions require field-linked evidence and clear confirmation only after success', async ({
  page,
}) => {
  let writes = 0;
  let dispute = {
    id,
    guidelineId: 'synthetic-guideline',
    guidelineVersion: 'test',
    guidelineContentSha256: 'a'.repeat(64),
    locator: { table: 'Table 1', row: 'Normal', column: null },
    status: 'open',
    inForce: true,
    note: null,
    decision: null as unknown,
    createdAt: 'now',
  };
  await page.route('**/api/v1/cell-disputes?*', (route) =>
    route.fulfill({ json: { data: [dispute], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } } }),
  );
  await page.route('**/api/v1/cell-disputes/' + id + '/decision', (route) => {
    writes++;
    dispute = {
      ...dispute,
      status: 'upheld',
      decision: { id, decision: 'upheld', evidence: null, createdAt: 'now' },
    };
    return route.fulfill({ json: dispute });
  });
  await signInAs(page, 'gina', '/local-operations');
  await page.getByRole('button', { name: 'Refresh disputes' }).click();
  await page.getByRole('button', { name: id + ' — open', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Uphold dispute' }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    )
    .check();
  await page.getByRole('button', { name: 'Uphold dispute' }).click();
  await expect(
    page.getByLabel('Synthetic note or decision evidence'),
  ).toHaveAccessibleDescription('Enter decision evidence.');
  await expect(
    page.getByLabel('Synthetic note or decision evidence'),
  ).toBeFocused();
  expect(writes).toBe(0);
  await accessible(page);
  await page
    .getByLabel('Synthetic note or decision evidence')
    .fill('Synthetic evidence');
  await expect(
    page.getByRole('button', { name: 'Uphold dispute' }),
  ).toBeDisabled();
  await page
    .getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    )
    .check();
  await page.getByRole('button', { name: 'Uphold dispute' }).click();
  await expect(
    page.getByRole('button', { name: id + ' — upheld', exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await expect(
    page.getByLabel(
      'I reviewed the selected record and intend this synthetic change',
    ),
  ).not.toBeChecked();
  await expect(
    page.getByLabel('Synthetic note or decision evidence'),
  ).toHaveValue('');
  await accessible(page);
});
