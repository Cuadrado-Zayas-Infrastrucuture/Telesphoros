import { expect, test } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from './helpers';

const primary = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Primary', exact: true });

test('Settings and Usage share the sidebar with Reports and Upload', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  await openWorkspaceNavigation(page);
  for (const name of ['Reports', 'Upload report', 'Settings']) await expect(primary(page).getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.locator('header.workspace-navigation')).toBeVisible();
});

test.describe('desktop collapse', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'the collapse is a desktop control');

  for (const dark of [false, true]) {
    test(`collapses to icons with names kept, one Sign out, and no WCAG A/AA violations (${dark ? 'dark' : 'light'})`, async ({ page }, info) => {
      if (dark) await page.addInitScript(() => window.localStorage.setItem('telesphoros.theme', 'dark'));
      await signInAs(page, 'alice', '/settings');
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      const sidebar = page.locator('header.workspace-navigation');
      await expect(sidebar).toHaveClass(/is-collapsed/);
      expect((await sidebar.boundingBox())!.width).toBeLessThanOrEqual(80);
      await expect(primary(page).getByRole('link', { name: 'Upload report', exact: true })).toHaveAttribute('title', 'Upload report');
      // Settings has its own Sign out in the page; inside the sidebar exactly one is visible: the icon.
      await expect(sidebar.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true })).toHaveCount(1);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: `test-results/sidebar/collapsed-${dark ? 'dark' : 'light'}-${info.project.name}.png` });
      // The choice holds across in-page navigation, and expanding brings the names back.
      await primary(page).getByRole('link', { name: 'Reports', exact: true }).click();
      await expect(sidebar).toHaveClass(/is-collapsed/);
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      await expect(primary(page).getByText('Reports', { exact: true })).toBeVisible();
    });
  }
});

test('on a phone the sidebar stays a menu, and a desktop collapse never hides its names', async ({ page }, info) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'phone layout only');
  await page.addInitScript(() => window.localStorage.setItem('telesphoros.sidebar', 'collapsed'));
  await signInAs(page, 'alice', '/settings');
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
  await openWorkspaceNavigation(page);
  await expect(primary(page).getByText('Upload report', { exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/sidebar/phone-menu-${info.project.name}.png`, fullPage: true });
});

test('signed in, the landing header offers the way back into the workspace and no Sign out', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  await openWorkspaceNavigation(page);
  await primary(page).getByRole('link', { name: 'Overview', exact: true }).click();
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: 'Open workspace' })).toHaveAttribute('href', '/reports');
  await expect(banner.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
