import { expect, test, type Page, type Request } from '@playwright/test';
import { signInAs } from './helpers';

const EMAIL = { alice: 'alice@example.test', dave: 'dave@example.test' } as const;

/** Every request the page makes, flattened to text, so a test can prove a value never left the browser. */
function recordRequests(page: Page): () => Promise<string[]> {
  const seen: Request[] = [];
  page.on('request', (request) => seen.push(request));
  return () => Promise.all(seen.map(async (r) => JSON.stringify([r.url(), await r.allHeaders(), r.postData() ?? ''])));
}

test('a clinician sees the email from the real sign-in, the organization and their role, and the email never leaves the browser', async ({ page }) => {
  const requests = recordRequests(page);
  await signInAs(page, 'alice', '/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const account = page.getByRole('region', { name: 'Account' });
  await expect(account.getByText(EMAIL.alice)).toBeVisible();
  await expect(account.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Roles' }).getByText('Clinician', { exact: true })).toBeVisible();
  for (const request of await requests()) expect(request).not.toContain(EMAIL.alice);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(EMAIL.alice);
});

test('a member with no role can open Settings, and is told why there is little else', async ({ page }) => {
  await signInAs(page, 'dave', '/settings');
  await expect(page.getByRole('region', { name: 'Account' }).getByText(EMAIL.dave)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Roles' }).getByText(/without a role yet/)).toBeVisible();
});

test('reloading signs the tab out: Settings then asks to sign in and shows no email', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  await expect(page.getByText(EMAIL.alice)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(EMAIL.alice)).toHaveCount(0);
});
