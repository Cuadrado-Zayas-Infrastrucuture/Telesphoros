import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

test('production build has no one-screen workspace route or link (specs/016 OSW-3, specs/022 WMS-3)', async ({ page }) => {
  await signInAs(page, 'alice', '/reports');
  await expect(page.getByRole('link', { name: 'Workspace', exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/local-workspace"]')).toHaveCount(0);
  await page.goto('/local-workspace');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start with a synthetic report.' })).toHaveCount(0);
});

test('production sign-in from the home page lands on the chat home for a clinician (specs/024 CH-1; was the home page in specs/022 WMS-1)', async ({ page }) => {
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Sign in as alice\b/ }).click();
  await page.waitForURL('**/auth/callback**');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'));
  expect(new URL(page.url()).pathname).toBe('/workspace');
});

test('production build has no interpretation preview route', async ({ page }) => {
  await page.goto('/local-interpretation');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sample question' })).toHaveCount(0);
  await expect(page.getByText('SYN-PGX-UI-01', { exact: false })).toHaveCount(0);
});
