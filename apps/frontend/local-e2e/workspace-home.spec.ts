import { expect, test } from '@playwright/test';

// specs/022: in the local preview (development build on 127.0.0.1) the one-screen workspace is the main screen.
test('signing in from the home page opens the workspace (WMS-2)', async ({ page }) => {
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Sign in as alice\b/ }).click();
  await page.waitForURL('**/local-workspace');
  await expect(page.getByRole('heading', { name: 'Which report should we read?' })).toBeVisible();
  await expect(page).toHaveTitle(/^Workspace\b/);
});
