import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

test('production build has no one-screen workspace route or link (specs/016 OSW-3)', async ({ page }) => {
  await signInAs(page, 'alice', '/reports');
  await expect(page.getByRole('link', { name: 'Workspace preview' })).toHaveCount(0);
  await page.goto('/local-workspace');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Which report should we read?' })).toHaveCount(0);
});

test('production build has no interpretation preview route', async ({ page }) => {
  await page.goto('/local-interpretation');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sample question' })).toHaveCount(0);
  await expect(page.getByText('SYN-PGX-UI-01', { exact: false })).toHaveCount(0);
});
