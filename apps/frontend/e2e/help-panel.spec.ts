import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openPatients, openWorkspaceNavigation, signInAs, signInWithPatient } from './helpers';

// Spec 051 slice H2: the curated Help panel in a real browser at both configured viewports (375 and 1280 px),
// light and dark themes, by keyboard, with 44 px targets and zero WCAG A/AA violations.

/** Opens the patient's page via client-side navigation (a full reload would wipe the in-memory session). */
async function openPatientPage(page: Page, label: string) {
  await openPatients(page);
  await expect(page.getByRole('list', { name: 'Patients' })).toBeVisible();
  const link = page.getByRole('link', { name: label, exact: true });
  const more = page.getByRole('button', { name: 'More patients', exact: true });
  for (let attempts = 0; attempts < 100 && (await link.count()) === 0; attempts++) {
    if ((await more.count()) === 0) break;
    await more.click();
    await expect.poll(async () => (await link.count()) > 0 || (await more.count()) === 0 || (await more.isEnabled())).toBe(true);
  }
  await link.click();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Help drawer opens by keyboard on screen-contextual articles, searches without network calls, closes on Escape, and has no axe violations (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await signInAs(page, 'alice', '/workspace');
    await openWorkspaceNavigation(page);

    const helpButton = page.locator('header.workspace-navigation').getByRole('button', { name: 'Help', exact: true });
    await expect(helpButton).toBeVisible();
    await helpButton.focus();
    await page.keyboard.press('Enter');

    const drawer = page.locator('#help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2, name: 'Help' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /What the home page shows/ })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /What a held result means/ })).toBeVisible();
    await expect(drawer.getByText('Draft: not yet reviewed by a pharmacist.').first()).toBeVisible();

    // Every visible control inside the Help drawer meets the 44 px touch target minimum.
    const small = await drawer.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('a, button, input')]
        .filter((el) => !el.closest('[hidden]'))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
        .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
    );
    expect(small).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);

    // Typing a search query must trigger zero network requests.
    const requestsDuringTyping: string[] = [];
    const recordRequest = (request: import('@playwright/test').Request) => requestsDuringTyping.push(request.url());
    page.on('request', recordRequest);

    const search = drawer.getByRole('searchbox', { name: 'Search help' });
    await search.fill('what does phenotype mean');
    await expect(drawer.getByRole('button', { name: /Phenotype/ })).toBeVisible();
    expect(requestsDuringTyping).toEqual([]);

    // Weak match banner appears when fewer than half the words match.
    await search.fill('held quantum spaceship banana toaster');
    await expect(drawer.getByText('No article answers that exactly. These are the closest:')).toBeVisible();
    expect(requestsDuringTyping).toEqual([]);

    page.off('request', recordRequest);

    // Escape closes the drawer and returns focus to the Help button on both desktop and mobile.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(helpButton).toBeFocused();
  });
}

test('refuses patient questions before searching and links to the patient results on a patient page', async ({ page }) => {
  const patient = await signInWithPatient(page);
  await openPatientPage(page, patient.label);
  await expect(page.getByRole('heading', { level: 1, name: patient.label })).toBeVisible();

  await openWorkspaceNavigation(page);
  const helpButton = page.locator('header.workspace-navigation').getByRole('button', { name: 'Help', exact: true });
  await helpButton.focus();
  await page.keyboard.press('Enter');

  const drawer = page.locator('#help-drawer');
  await expect(drawer).toBeVisible();

  const search = drawer.getByRole('searchbox', { name: 'Search help' });
  await search.fill('can my patient take clopidogrel');

  await expect(drawer.getByText(/Help explains how the product works\. It does not answer questions about a patient\./)).toBeVisible();
  await expect(drawer.getByRole('link', { name: /Open this patient's results/ })).toHaveAttribute('href', `/patients/${patient.id}#genomic-profile-heading`);
  expect(await axeViolations(page)).toEqual([]);
});
