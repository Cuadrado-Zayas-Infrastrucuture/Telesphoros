import { expect, test } from '@playwright/test';
test('production build has no interpretation preview route', async ({ page }) => {
  await page.goto('/local-interpretation');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sample question' })).toHaveCount(0);
  await expect(page.getByText('SYN-PGX-UI-01', { exact: false })).toHaveCount(0);
});
