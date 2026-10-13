import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { JWT_PATTERN, ROLE, signInAs } from './helpers';

const require = createRequire(import.meta.url);

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page above
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
  });
}

test.describe('signing in', () => {
  test('an anonymous visitor to a protected page is sent to sign in; the sign-in page is accessible', async ({ page }) => {
    await page.goto('/reports/upload');
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('a clinician signs in through the identity provider and lands on the page they wanted', async ({ page }) => {
    await signInAs(page, 'alice');
    await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
    await expect(page.getByText(ROLE.alice, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    // The one-time code must not linger in the address bar (or the history).
    expect(page.url()).not.toMatch(/[?&](code|state)=/);
    expect(await axeViolations(page)).toEqual([]);
  });

  test('an admin can use the upload page too', async ({ page }) => {
    await signInAs(page, 'carol');
    await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
    await expect(page.getByText(ROLE.carol, { exact: true })).toBeVisible();
  });

  for (const persona of ['bob', 'dave'] as const) {
    test(`${persona} (${ROLE[persona]}) is told they lack access, and the form is not rendered`, async ({ page }) => {
      await signInAs(page, persona);
      await expect(page.getByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeVisible();
      await expect(page.getByLabel(/report file/i)).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Upload report' })).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  // erin is in no organization and frank is in two: the API refuses both (403), and the page says why.
  for (const persona of ['erin', 'frank'] as const) {
    test(`${persona} signs in but is told the account is not set up, with no pointless retry`, async ({ page }) => {
      await page.goto('/reports/upload');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('button', { name: new RegExp(`Sign in as ${persona}\\b`) }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Your account is not set up yet' })).toBeVisible();
      await expect(page.getByText('No organization is assigned to your account')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
      await expect(page.getByLabel(/report file/i)).toHaveCount(0);
      expect(page.url()).not.toMatch(/[?&](code|state)=/);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('a failed sign-in callback shows a clear message and a way to retry', async ({ page }) => {
    await page.goto('/auth/callback?code=bogus&state=bogus');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign-in did not complete' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/signin');
    expect(page.url()).not.toMatch(/[?&](code|state)=/); // a failed attempt does not leave its one-time values behind
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe('where the token lives', () => {
  test('never in localStorage, sessionStorage, cookies or IndexedDB, and not in the URL', async ({ page }) => {
    await signInAs(page, 'alice');
    await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
    const stored = await page.evaluate(async () => ({
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      cookie: document.cookie,
      databases: (await indexedDB.databases()).map((d) => d.name),
    }));
    for (const [where, value] of Object.entries({ localStorage: stored.local, sessionStorage: stored.session, cookies: stored.cookie })) {
      expect(value, `${where} must hold no JWT`).not.toMatch(JWT_PATTERN);
      expect(value, `${where} must hold no oidc user record`).not.toMatch(/oidc\.user/);
    }
    expect(stored.databases).toEqual([]);
    expect(page.url()).not.toMatch(JWT_PATTERN);
  });

  test('a page reload forgets the user locally; signing in again is instant because the provider still has a session', async ({ page }) => {
    await signInAs(page, 'alice');
    const loginPosts: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/oauth2/login') && loginPosts.push(r.url()));

    await page.reload();
    await expect(page).toHaveURL(/\/signin$/); // nothing was kept: the app starts signed out
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/reports/upload');
    await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
    expect(loginPosts).toEqual([]); // no second login prompt
  });
});

test.describe('signing out', () => {
  test('ends the provider session as well, so the next sign-in asks again', async ({ page }) => {
    await signInAs(page, 'alice');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await expect(page.getByRole('heading', { level: 1, name: 'You have been signed out' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    const loginPosts: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/oauth2/login') && loginPosts.push(r.url()));
    await page.goto('/reports/upload');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /Fake identity provider/ })).toBeVisible(); // asked for credentials again
    await page.getByRole('button', { name: /Sign in as alice\b/ }).click();
    await page.waitForURL('**/reports/upload');
    expect(loginPosts).toHaveLength(1);
  });
});

test.describe('the keyboard', () => {
  test('the sign-in button is reachable and works without a mouse', async ({ page }) => {
    await page.goto('/signin');
    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // brand
    for (let i = 0; i < 6 && !(await page.getByRole('button', { name: 'Sign in' }).evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Fake identity provider/ })).toBeVisible();
  });
});


test('reports remains unavailable without the owned-storage opt-in', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
});
