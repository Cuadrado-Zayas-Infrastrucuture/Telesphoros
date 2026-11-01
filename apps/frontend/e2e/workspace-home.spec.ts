import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs, type Persona } from './helpers';

// Spec 024: the chat-first home in a production-mode build (`vite build --mode e2e`, so `import.meta.env.DEV` is false and the local preview gate is off
// whatever the host name). The fake identity provider's redirect address fixes the host at 127.0.0.1; the unit tests cover `localhost` and a deployed host.

const NOTE = 'Interpretation is not available in the prototype yet.';
const HEADING = 'Start with a synthetic report.';
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
      if (path === '/workspace') await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    });
  }

  test('/workspace opens on this host for a signed-in member, with the notice, and the local workspace is still absent', async ({ page }) => {
    await signInAs(page, 'dave', '/workspace');
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    await expect(page.getByText('Synthetic data only. Not for clinical use.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach a report' })).toHaveCount(0);
    await page.goto('/local-workspace');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});

test.describe('the feature panel (CH-2)', () => {
  const cases = [
    ['alice', ['New chat', 'Past reports', 'Patients', 'Upload report', 'All reports', 'Settings']],
    ['bob', ['New chat', 'Past reports', 'Patients', 'All reports', 'Settings']],
    ['carol', ['New chat', 'Usage', 'Settings']],
  ] as const;
  for (const [persona, expected] of cases) {
    test(`lists, in order, only what ${persona} may use`, async ({ page }) => {
      await signInAs(page, persona, '/workspace');
      await openWorkspaceNavigation(page);
      expect(await panelItems(page)).toEqual(expected);
      await expect(page.locator('.workspace-account').getByRole('button', { name: 'Sign out' }).filter({ visible: true })).toHaveCount(1);
    });
  }

  test('past reports and patients come from the API, as words and labels', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await openWorkspaceNavigation(page);
    await expect(primary(page).getByRole('region', { name: 'Past reports' })).toBeVisible();
    await expect(primary(page).getByRole('region', { name: 'Patients' })).toBeVisible();
  });

  test('New chat opens an empty conversation', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await page.getByRole('textbox', { name: 'Question' }).fill('A first question');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(NOTE)).toBeVisible();
    await openWorkspaceNavigation(page);
    await primary(page).getByRole('link', { name: 'New chat', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    await expect(page.getByText('A first question')).toHaveCount(0);
  });

  test('on a desktop the collapse is remembered while navigating', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the collapse is a desktop control');
    await signInAs(page, 'alice', '/workspace');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const sidebar = page.locator('header.workspace-navigation');
    await expect(sidebar).toHaveClass(/is-collapsed/);
    expect(await page.evaluate(() => window.localStorage.getItem('telesphoros.sidebar'))).toBe('collapsed');
    await primary(page).getByRole('link', { name: 'All reports', exact: true }).click();
    await expect(page).toHaveURL(/\/reports$/);
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

test.describe('the conversation', () => {
  test('a typed question gets the note, never an answer, and sends no request (CH-4, CH-5)', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await expect(page.getByRole('button', { name: 'Attach a report' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
    await page.getByRole('textbox', { name: 'Question' }).fill('What does CYP2C19 *2/*2 mean?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(NOTE)).toHaveCount(1);
    await expect(page.getByText('What does CYP2C19 *2/*2 mean?')).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
    // No sample answers and no sample-question buttons exist outside the local preview.
    await expect(page.getByRole('group', { name: 'Sample questions' })).toHaveCount(0);
    await expect(page.getByText(/Sample answer/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Explain this' })).toHaveCount(0);
  });

  test('a JSON report goes up once with the confirmation, shows its status word, and "Check status" reloads it (CH-3)', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    const declarations: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/reports') declarations.push(request.url());
    });
    const name = `chat-${crypto.randomUUID().slice(0, 8)}.json`;
    await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
    await page.getByRole('combobox', { name: 'Patient' }).selectOption({ label: 'New synthetic patient…' });
    const newLabel = page.getByRole('textbox', { name: 'New patient label' });
    await expect(newLabel).toHaveAccessibleDescription('Letters, numbers and hyphens. A code, never a name.');
    for (const control of [page.getByRole('combobox', { name: 'Patient' }), newLabel]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(await control.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    }
    expect(await axeViolations(page)).toEqual([]);
    await newLabel.fill(label());
    // Without the confirmation nothing is sent. Send is aria-disabled so that it can still say why; Playwright treats that as disabled, hence force.
    await page.getByRole('button', { name: 'Send' }).click({ force: true });
    await expect(page.getByRole('status').filter({ hasText: 'Confirm the file is synthetic.' })).toBeVisible();
    expect(declarations).toEqual([]);
    await page.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
    await page.getByRole('button', { name: 'Send' }).click();
    const thread = page.getByRole('region', { name: 'Conversation' });
    await expect(thread.getByText(name)).toBeVisible();
    const word = thread.getByText(/^(Received|Processing|Processed|Failed)$/);
    await expect(word).toBeVisible();
    expect(declarations).toHaveLength(1);
    const reload = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/reports' && request.method() === 'GET');
    await thread.getByRole('button', { name: 'Check status' }).click();
    await reload;
    await expect(word).toBeVisible();
    expect(declarations).toHaveLength(1);
    // The panel lists reports too. The list is the oldest page and the suite shares one organization, so this report may not be on it: check the list shows words.
    await openWorkspaceNavigation(page);
    await expect(primary(page).getByRole('list', { name: 'Past reports' }).getByRole('listitem').first()).toBeVisible();
  });

  test('a PDF is refused with a message naming the local preview, and nothing is uploaded (CH-6)', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });
    await page.locator('input[type=file]').setInputFiles({ name: 'SYN-004.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByRole('alert').filter({ hasText: /local preview/i })).toBeVisible();
    await page.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
    await page.getByRole('button', { name: 'Send' }).click({ force: true });
    await expect(page.getByRole('alert').filter({ hasText: /local preview/i })).toBeVisible();
    expect(posts).toEqual([]);
  });
});

test.describe('accessibility and layout (CH-7)', () => {
  for (const dark of [false, true]) {
    test(`no WCAG A/AA violations: empty, file attached, and with a note (${dark ? 'dark' : 'light'})`, async ({ page }) => {
      if (dark) await page.addInitScript(() => window.localStorage.setItem('telesphoros.theme', 'dark'));
      await signInAs(page, 'alice', '/workspace');
      await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
      await openWorkspaceNavigation(page); // on a phone the panel is a drawer; open it so axe sees the lists too
      await expect(primary(page).getByRole('region', { name: 'Past reports' })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('input[type=file]').setInputFiles({ name: 'axe.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
      await expect(page.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole('button', { name: 'Remove file' }).click();
      await page.getByRole('textbox', { name: 'Question' }).fill('A question');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText(NOTE)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  for (const width of [390, 768, 1280]) {
    test(`nothing scrolls sideways at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await signInAs(page, 'alice', '/workspace');
      await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow(), 'empty state').toBeLessThanOrEqual(0);
      await page.locator('input[type=file]').setInputFiles({ name: 'a-rather-long-synthetic-report-file-name-for-layout.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
      await expect(page.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' })).toBeVisible();
      expect(await overflow(), 'file attached').toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Remove file' }).click();
      await page.getByRole('textbox', { name: 'Question' }).fill('A question');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText(NOTE)).toBeVisible();
      expect(await overflow(), 'conversation').toBeLessThanOrEqual(0);
    });
  }
});

test.describe('Add patient in the panel (CH-9)', () => {
  test('a writer adds one synthetic patient; it shows in the section and the chat choice; a bad label sends nothing; a reader has no control', async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await page.locator('input[type=file]').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
    await openWorkspaceNavigation(page);
    const section = page.getByRole('region', { name: 'Patients' });
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/patients') posts.push(request.url());
    });
    await section.getByRole('button', { name: 'Add patient' }).click();
    await section.getByRole('textbox', { name: 'Synthetic patient label' }).fill('Jane Doe');
    await section.getByRole('button', { name: 'Create patient' }).click();
    await expect(section.getByRole('alert')).toBeVisible();
    expect(posts).toEqual([]);
    const created = label();
    await section.getByRole('textbox', { name: 'Synthetic patient label' }).fill(created);
    await section.getByRole('button', { name: 'Create patient' }).click();
    await expect(section.getByRole('list', { name: 'Patients' }).getByText(created)).toBeVisible();
    expect(posts).toHaveLength(1);
    await expect(page.getByRole('combobox', { name: 'Patient' }).locator('option', { hasText: created })).toHaveCount(1);
  });

  test('a reader sees the Patients section without the control', async ({ page }) => {
    await signInAs(page, 'bob', '/workspace');
    await openWorkspaceNavigation(page);
    await expect(page.getByRole('region', { name: 'Patients' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add patient' })).toHaveCount(0);
  });
});
