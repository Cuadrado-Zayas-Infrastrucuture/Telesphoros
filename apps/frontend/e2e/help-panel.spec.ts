import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from './helpers';

// Spec 051 slice H2, made a conversation by spec 053 slice C1: the help panel in a real browser, at the two widths every browser test runs at
// (375 and 1280 px), light and dark, by keyboard. The panel reads only the bundled articles, so the real e2e app is enough: nothing is served
// from a fixture.

const helpButton = (page: Page) => page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('button', { name: 'Help', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Help', exact: true });
const box = (page: Page) => panel(page).getByRole('textbox', { name: 'Ask Help', exact: true });
const conversation = (page: Page) => panel(page).getByRole('log', { name: 'Conversation with Help' });
const answers = (page: Page) => conversation(page).getByRole('listitem', { name: 'Help', exact: true });

async function openHelp(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme });
  await signInAs(page, 'alice', '/workspace');
  await expect(page.getByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
  await openWorkspaceNavigation(page);
  await helpButton(page).click();
  await expect(panel(page)).toBeVisible();
}

async function ask(page: Page, question: string) {
  const before = await answers(page).count();
  await box(page).fill(question);
  await box(page).press('Enter');
  await expect(answers(page)).toHaveCount(before + 1);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Help opens over the worklist in the ${colorScheme} theme: its articles, an answer, no sideways scroll, no WCAG A/AA violation`, async ({ page }) => {
    await openHelp(page, colorScheme);
    await expect(panel(page).getByRole('button', { name: 'What the home page shows', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await panel(page).getByRole('button', { name: 'What a held result means', exact: true }).click();
    await expect(answers(page).last().getByText('Draft: not yet reviewed by a pharmacist.')).toBeVisible();
    await ask(page, 'zebra');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('every control in the help panel is a 44 px target, before and after an answer', async ({ page }) => {
  await openHelp(page, 'light');
  const small = () =>
    panel(page).evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('a, button, input')]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
        .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
    );
  expect(await small()).toEqual([]);
  await ask(page, 'overdue follow-up reminder');
  await expect(answers(page).last().getByRole('link', { name: 'Open Follow-ups' })).toBeVisible();
  await ask(page, 'zebra');
  expect(await small()).toEqual([]);
});

test('by keyboard: open Help, ask, read the quoted article, and Escape returns to Help', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  await helpButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { level: 2, name: 'Help', exact: true })).toBeFocused();
  await box(page).focus();
  await page.keyboard.type('held result');
  await page.keyboard.press('Enter');
  await expect(answers(page).last().getByRole('article', { name: 'From: What a held result means' })).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeVisible();
  await expect(helpButton(page)).toBeFocused();
  // Opened again, the conversation is gone (spec 053 section 1).
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('log')).toHaveCount(0);
});

test('a question about a patient is refused before any search, and nothing is sent while asking', async ({ page }) => {
  await openHelp(page, 'light');
  const requests: string[] = [];
  // Only calls to the API count: the panel's code is already loaded, and nothing typed may leave the browser.
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url());
  });
  await ask(page, 'can my patient take clopidogrel');
  await expect(answers(page).last()).toContainText('It does not answer questions about a patient.');
  await expect(answers(page).last().getByRole('article')).toHaveCount(0);
  await ask(page, 'held result');
  expect(requests).toEqual([]);
});

test('at 375 px, three exchanges: the newest answer is in view, the box stays in view, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await openHelp(page, 'light');
  await ask(page, 'what is a held result');
  await ask(page, 'overdue follow-up reminder');
  await ask(page, 'how do I add a patient');
  await expect(answers(page).last().getByRole('heading', { level: 3 })).toBeInViewport();
  await expect(box(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
