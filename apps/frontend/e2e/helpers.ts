import { expect, type Page } from '@playwright/test';

export type Persona = 'alice' | 'bob' | 'carol' | 'dave';
export const ROLE: Record<Persona, string> = { alice: 'clinician', bob: 'reader', carol: 'admin', dave: 'no role' };

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
