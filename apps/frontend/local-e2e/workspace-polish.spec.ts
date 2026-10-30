import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, signInAs } from '../e2e/helpers';

// specs/023: the one-screen workspace, polished. Each test fails on the screen as it was before the spec.

/** True when the element's centre is the topmost thing there, so nothing (the sticky input bar) covers it. */
async function uncovered(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && (hit === element || element.contains(hit));
  });
}

async function answerOnce(page: Page) {
  await page.getByRole('button', { name: 'Explain this', exact: true }).click();
  await expect(page.getByText(/No genotype, phenotype/)).toBeVisible();
}

test('on a phone, the end of an answer is not hidden behind the input bar (WP-1)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInAs(page, 'alice', '/local-workspace');
  await answerOnce(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.getByRole('button', { name: 'Not helpful', exact: true })).toBeInViewport();
  expect(await uncovered(page.getByText('Sample answer from synthetic data. Not clinical advice.'))).toBe(true);
  expect(await uncovered(page.getByRole('button', { name: 'Not helpful', exact: true }))).toBe(true);
  // All three sample questions fit on screen in the docked row, none cut off at the edge.
  for (const chip of await page.locator('.one-screen-dock').getByRole('button', { name: /^(Explain this|Missing evidence|Limitations)$/ }).all()) await expect(chip).toBeInViewport({ ratio: 1 });
  // The bar that stays on screen takes at most a third of a phone screen.
  const bar = await page.locator('.one-screen-dock').boundingBox();
  expect(bar?.height ?? Infinity).toBeLessThanOrEqual(844 / 3);
});

test('the empty workspace is honest, calm and keeps its notice by the input (WP-2, WP-5, WP-6)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInAs(page, 'alice', '/local-workspace');
  await expect(page.getByRole('heading', { level: 1, name: 'Start with a synthetic report.' })).toBeVisible();
  await expect(page.getByText('ACGTTCAG', { exact: false })).toHaveCount(0);
  // Each sample question fits one line.
  const chips = page.getByRole('group', { name: 'Sample questions' }).getByRole('button');
  await expect(chips).toHaveText(['Explain this', 'Missing evidence', 'Limitations']);
  for (const chip of await chips.all()) expect((await chip.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(44);
  // The notice sits just below the input, not at the foot of the window.
  const box = await page.locator('.one-screen-box').boundingBox();
  const notice = await page.getByText('Synthetic data only. Not for clinical use.').boundingBox();
  expect((notice?.y ?? Infinity) - ((box?.y ?? 0) + (box?.height ?? 0))).toBeLessThanOrEqual(120);
  expect(await axeViolations(page)).toEqual([]);
});

test('an attached report reads on clean lines with the full confirmation (WP-3)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInAs(page, 'alice', '/local-workspace');
  await page.locator('input[type="file"]').setInputFiles({ name: 'SYN-0042-cyp2c19.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
  const name = page.getByText('SYN-0042-cyp2c19.json', { exact: true });
  const remove = page.getByRole('button', { name: 'Remove file', exact: true });
  // The remove button stays on the file's line instead of wrapping onto its own.
  expect(Math.abs(((await remove.boundingBox())?.y ?? 0) + ((await remove.boundingBox())?.height ?? 0) / 2 - (((await name.boundingBox())?.y ?? 0) + ((await name.boundingBox())?.height ?? 0) / 2))).toBeLessThanOrEqual(8);
  // The patient picker shows its whole choice.
  const select = page.getByRole('combobox', { name: 'Patient', exact: true });
  await select.selectOption({ label: 'New synthetic patient…' });
  expect(await select.evaluate((element: HTMLSelectElement) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // Same confirmation sentence as the Upload page.
  await expect(page.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only', exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('feedback asks about the answer, in light and dark (WP-4)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 860 });
    if (scheme === 'light') await signInAs(page, 'alice', '/local-workspace');
    else await page.getByRole('button', { name: 'New interpretation', exact: true }).click();
    await answerOnce(page);
    await expect(page.getByText('Was this answer helpful?', { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  }
});
