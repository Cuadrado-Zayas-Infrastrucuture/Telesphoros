import { expect, test, type Page } from '@playwright/test';
import { openPatients, openWorkspaceNavigation, signInAs, type Persona } from './helpers';

// The signed-in frame in a production-mode build (`vite build --mode e2e`, so `import.meta.env.DEV` is false and the local preview gate is off
// whatever the host name): where signing in lands, the sidebar, and the retired chat (spec 052 RC1b). The chat's own cases left with it; each is
// named in docs/verification/2026-11-25-retire-the-chat-rc1b.md. The fake identity provider's redirect address fixes the host at 127.0.0.1.

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary', exact: true });

/** Signs in from the sign-in page, as a person arriving at the home page would, and waits until the callback has moved on. */
async function signInFromHome(page: Page, persona: Persona) {
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: new RegExp(`Sign in as ${persona}\\b`) }).click();
  await page.waitForURL('**/auth/callback**');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'));
}

const panelItems = (page: Page) => primary(page).locator('[data-panel-item]').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.panelItem));
const label = () => `SYN-${crypto.randomUUID().slice(0, 8)}`;

test.describe('where signing in lands (CH-1)', () => {
  for (const [persona, path] of [['alice', '/workspace'], ['bob', '/workspace'], ['gina', '/workspace'], ['carol', '/'], ['dave', '/']] as const) {
    test(`${persona} lands on ${path}`, async ({ page }) => {
      await signInFromHome(page, persona);
      expect(new URL(page.url()).pathname).toBe(path);
      // Spec 049 W-D5: the home is the worklist.
      if (path === '/workspace') await expect(page.getByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
    });
  }

  // Spec 052 RC-5, RC-D2: an old link or bookmark to the chat lands on the home, even for a member with no role.
  test('/chat sends a signed-in member to the home, and the local workspace is still absent', async ({ page }) => {
    // Not signInAs: it waits for the address it was given, and /chat moves on to /workspace at once.
    await page.goto('/chat');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    const consent = page.getByRole('button', { name: 'Allow preferences', exact: true });
    if (await consent.count()) await consent.click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: /Sign in as dave\b/ }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByText('Your account has no clinical role, so there is no work to show here.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Question' })).toHaveCount(0);
    await page.goto('/local-workspace');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});

test.describe('the feature panel (CH-2, specs/034 D1)', () => {
  // Spec 052 RC-6: no Chat for anyone.
  const cases = [
    ['alice', ['Home', 'Patients', 'Reports', 'Follow-ups', 'Recents']],
    ['bob', ['Home', 'Patients', 'Reports', 'Recents']],
    ['carol', ['Usage']],
  ] as const;
  for (const [persona, expected] of cases) {
    test(`lists, in order, only what ${persona} may use`, async ({ page }) => {
      await signInAs(page, persona, '/workspace');
      await openWorkspaceNavigation(page);
      expect(await panelItems(page)).toEqual(expected);
      await expect(primary(page).getByRole('link', { name: 'Chat', exact: true })).toHaveCount(0);
      await expect(page.locator('.workspace-account').getByRole('button', { name: /^Account, / })).toBeVisible();
    });
  }

  test('recent reports come from the API, and patients have their own page (specs/034 D2, D3)', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await openWorkspaceNavigation(page);
    await expect(primary(page).getByText('Recents', { exact: true })).toBeVisible();
    await openPatients(page);
    await expect(page.getByRole('region', { name: 'Patient records' })).toBeVisible();
  });

  test('on a desktop the collapse is remembered while navigating', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the collapse is a desktop control');
    await signInAs(page, 'alice', '/workspace');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const sidebar = page.locator('header.workspace-navigation');
    await expect(sidebar).toHaveClass(/is-collapsed/);
    expect(await page.evaluate(() => window.localStorage.getItem('telesphoros.sidebar'))).toBe('collapsed');
    await primary(page).getByRole('link', { name: 'Reports', exact: true }).click();
    await expect(page).toHaveURL(/\/reports$/);
    // Reports is a page (specs/041 C1), not a panel to close.
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(sidebar).toHaveClass(/is-collapsed/);
  });

  test('on a phone it is a drawer: Tab stays inside it, and Escape closes it and returns focus to the menu button', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'phone layout only');
    await signInAs(page, 'alice', '/workspace');
    const toggle = page.getByRole('button', { name: 'Workspace navigation', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('header.workspace-navigation'))).toBe(true);
    }
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('header.workspace-navigation'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });
});

test('a reader sees the Patients page without the Add patient control (CH-9)', async ({ page }) => {
  await signInAs(page, 'bob', '/workspace');
  await openPatients(page);
  await expect(page.getByRole('region', { name: 'Patient records' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add patient' })).toHaveCount(0);
});

// Kept from the chat's cases, started from the Patients page instead (spec 052 RC1b): the replay rule belongs to adding a patient, not to the chat.
test('a lost patient-create response locks creation, then retries the same identity and creates the patient once', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const bodies: unknown[] = [];
  const returnedIds: string[] = [];
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/patients', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    const stored = await route.fetch();
    expect(stored.ok()).toBe(true);
    returnedIds.push((await stored.json()).id);
    if (bodies.length === 1) {
      await responseGate;
      await route.abort('failed'); // The real API created it; only its response is lost.
    } else await route.fulfill({ response: stored });
  });
  await signInAs(page, 'alice', '/workspace');
  await openPatients(page);
  await page.getByRole('link', { name: 'Add patient', exact: true }).click();
  const created = label();
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(created);
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  const pending = page.getByRole('button', { name: 'Saving…', exact: true });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await expect(pending.locator('svg')).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('textbox', { name: 'Synthetic patient label' })).toHaveAttribute('readonly');
  await pending.scrollIntoViewIfNeeded();
  const box = await pending.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const form = page.getByRole('main').locator('form').filter({ has: pending });
  try {
    const headingBox = await page.getByRole('heading', { level: 1, name: 'New patient' }).boundingBox();
    const formBox = await form.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(formBox).not.toBeNull();
    expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(formBox!.y);
    await page.screenshot({ path: info.outputPath('patient-create-pending.png') });
    await form.evaluate((node) => (node as HTMLFormElement).requestSubmit());
    expect(bodies).toHaveLength(1);
  } finally {
    release(); // Also settle the held response when a layout assertion fails.
  }
  await expect(page.getByRole('alert').filter({ hasText: /patient/i })).toBeVisible();
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: created })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(returnedIds).toHaveLength(2);
  expect(returnedIds[1]).toBe(returnedIds[0]);
});
