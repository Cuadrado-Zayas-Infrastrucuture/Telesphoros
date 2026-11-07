import { expect, test } from '@playwright/test';
import { axeViolations, openAccountMenu, openWorkspaceNavigation, signInAs } from './helpers';

const primary = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Primary', exact: true });

test('workspace panels return to the shared sidebar and chat attachment action', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  await openWorkspaceNavigation(page);
  for (const name of ['New chat', 'Patients', 'Reports']) await expect(primary(page).getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.locator('header.workspace-navigation')).toBeVisible();
  await primary(page).getByRole('link', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Attach a report', exact: true })).toBeVisible();
});

test.describe('desktop collapse', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'the collapse is a desktop control');

  for (const dark of [false, true]) {
    test(`collapses to icons with names kept, the account menu still reachable, and no WCAG A/AA violations (${dark ? 'dark' : 'light'})`, async ({ page }, info) => {
      if (dark) await page.addInitScript(() => { window.localStorage.setItem('telesphoros.storage-consent.v1', JSON.stringify({ version: 1, preferences: true })); window.localStorage.setItem('telesphoros.theme', 'dark'); });
      await signInAs(page, 'alice', '/settings');
      expect(await axeViolations(page)).toEqual([]);
      await openWorkspaceNavigation(page);
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      const sidebar = page.locator('header.workspace-navigation');
      await expect(sidebar).toHaveClass(/is-collapsed/);
      expect((await sidebar.boundingBox())!.width).toBeLessThanOrEqual(80);
      await expect(primary(page).getByRole('link', { name: 'Reports', exact: true })).toHaveAttribute('title', 'Reports');
      await expect(page.getByRole('slider', { name: 'Sidebar width' })).toHaveCount(0);
      // Specs/034 D4: collapsed, the account row is its initial, and its menu still holds Settings and Sign out.
      await openAccountMenu(page);
      await expect(sidebar.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.screenshot({ path: `test-results/sidebar/collapsed-${dark ? 'dark' : 'light'}-${info.project.name}.png` });
      // The choice holds across in-page navigation, and expanding brings the names back.
      await primary(page).getByRole('link', { name: 'Reports', exact: true }).click();
      await expect(sidebar).toHaveClass(/is-collapsed/);
      await page.getByRole('button', { name: 'Close report history', exact: true }).click();
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      await expect(primary(page).getByText('Reports', { exact: true })).toBeVisible();
    });
  }

  test('drags wider and narrower within bounds, keeps the width in this browser, and resets on a double click (specs/034 D8)', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('telesphoros.storage-consent.v1', JSON.stringify({ version: 1, preferences: true })));
    await signInAs(page, 'alice', '/workspace');
    const sidebar = page.locator('header.workspace-navigation');
    const handle = page.getByRole('slider', { name: 'Sidebar width' });
    const start = (await sidebar.boundingBox())!;
    expect(Math.round(start.width)).toBe(272); // 17rem
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 64, 300, { steps: 4 });
    await page.mouse.up();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(336); // 21rem
    await expect(handle).toHaveAttribute('aria-valuenow', '21');
    // Far past the bounds, either way, it stops at 24rem and 14rem.
    await handle.focus();
    await page.keyboard.press('End');
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(384);
    await page.keyboard.press('Home');
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(224);
    // Kept in this browser (a reload would end the in-memory sign-in, so the stored value is read instead; the unit tests cover the read back).
    expect(await page.evaluate(() => window.localStorage.getItem('telesphoros.sidebar-width'))).toBe('14');
    await handle.dblclick();
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(272);
    expect(await axeViolations(page)).toEqual([]);
  });
});

test('on a phone the sidebar stays a menu, and a desktop collapse never hides its names', async ({ page }, info) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'phone layout only');
  await page.addInitScript(() => { window.localStorage.setItem('telesphoros.storage-consent.v1', JSON.stringify({ version: 1, preferences: true })); window.localStorage.setItem('telesphoros.sidebar', 'collapsed'); });
  await signInAs(page, 'alice', '/settings');
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
  await openWorkspaceNavigation(page);
  await expect(primary(page).getByText('Reports', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Sidebar width' })).toBeHidden();
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/sidebar/phone-menu-${info.project.name}.png`, fullPage: true });
});

test('signed in, the landing header offers the way back into the workspace and no Sign out', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  await openWorkspaceNavigation(page);
  await page.locator('header.workspace-navigation').getByRole('link', { name: /^Telesphoros/ }).first().click();
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: 'Open workspace' })).toHaveAttribute('href', '/workspace');
  await expect(banner.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
