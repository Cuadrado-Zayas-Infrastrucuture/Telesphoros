import { expect, type Page } from '@playwright/test';

export type Persona = 'alice' | 'bob' | 'carol' | 'dave' | 'gina';
export const ROLE: Record<Persona, string> = { alice: 'clinician', bob: 'reader', carol: 'admin', dave: 'no role', gina: 'reviewer' };

/**
 * Signs in exactly as a person would: open a protected page, get sent to sign in, click through to the
 * identity provider, pick an account there, and come back to the page they wanted.
 */
export async function signInAs(page: Page, persona: Persona, path = '/reports/upload') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: new RegExp(`Sign in as ${persona}\\b`) }).click();
  await page.waitForURL(`**${path}`);
}

/** A JWT-shaped string: three base64url parts, the first starting like a JSON header. */
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;


/** Create synthetic fixture data through the authenticated API; the product itself never creates patients. */
export async function signInWithPatient(page: Page) {
  const me = page.waitForResponse(response => response.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice');
  const authenticated = await me;
  const api = new URL(authenticated.url()).origin;
  const headers = { Authorization: authenticated.request().headers().authorization! };
  const created = await page.request.post(`${api}/api/v1/patients`, { headers, data: { label: `SYN-${crypto.randomUUID()}` } });
  expect(created.status()).toBe(201);
  const patient = await created.json() as { id: string; label: string };
  await page.getByRole('button', { name: 'Refresh patients' }).click();
  for (let attempts = 0; attempts < 100; attempts++) {
    await expect(page.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
    if (await page.getByRole('option', { name: patient.label, exact: true }).count()) return { ...patient, api, headers };
    const next = page.getByRole('button', { name: 'Next patients' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
  }
  throw new Error('Synthetic patient fixture was not listed within the bounded test pages.');
}

/** Selects a real synthetic fixture from independently bounded patient-option pages. */
export async function selectReportsPatient(page: Page, fixture: { id: string; label: string }) {
  const refresh = page.getByRole('button', { name: 'Refresh patient options', exact: true });
  await expect(refresh).toHaveAttribute('aria-disabled', 'false'); await refresh.click();
  for (let attempt = 0; attempt < 100; attempt++) {
    await expect(refresh).toHaveAttribute('aria-disabled', 'false');
    if (await page.getByRole('option', { name: fixture.label, exact: true }).count()) {
      await page.getByLabel('Filter by patient').selectOption(fixture.id); return;
    }
    const next = page.getByRole('button', { name: 'Next patient page', exact: true });
    if (!(await next.count()) || await next.getAttribute('aria-disabled') === 'true') break;
    await next.click();
  }
  throw new Error('Synthetic report patient was not listed within bounded option pages.');
}

/** Open the compact workspace menu before using a sidebar item on mobile. */
export async function openWorkspaceNavigation(page: Page) {
  const menu = page.getByRole('button', { name: 'Workspace navigation', exact: true });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
}
