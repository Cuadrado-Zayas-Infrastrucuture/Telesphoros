import { expect, test } from '@playwright/test';
import { openWorkspaceNavigation, signInAs } from '../e2e/helpers';

test('the storage prototype reports disabled processing without inventing stored results', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'Add patient', exact: true }).click();
  const label = `SYN-RESULTS-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Synthetic patient label', exact: true }).fill(label);
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recorded results', exact: true }).click();
  const results = page.getByRole('region', { name: 'Recorded results', exact: true });
  await expect(results.getByRole('alert')).toHaveText('Stored results are unavailable while report processing is disabled.');
  await expect(results.getByRole('button', { name: 'Record decision', exact: true })).toHaveCount(0);
  await expect(results.getByText('No stored evaluations for this patient.', { exact: true })).toHaveCount(0);
  await results.getByRole('button', { name: 'Retry stored results', exact: true }).click();
  await expect(results.getByRole('alert')).toHaveText('Stored results are unavailable while report processing is disabled.');
});
