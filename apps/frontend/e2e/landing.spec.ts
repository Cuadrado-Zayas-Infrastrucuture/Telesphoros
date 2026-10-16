import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './helpers';
const require = createRequire(import.meta.url);
async function axeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected in the test only.
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((item: { id: string; nodes: { target: string[] }[] }) => ({ id: item.id, targets: item.nodes.map(node => node.target) }));
  });
}
/** Time-based motion (the hero sequence, scene changes, the scroll cue) ends; scroll-linked drift has no end of its own. */
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.timeline !== document.timeline || animation.playState !== 'running'));
}
/** Scroll the whole page in steps, as a reader would, so every section's entrance has run. */
async function scrollThrough(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let top = 0; top < height; top += 400) { await page.evaluate(y => window.scrollTo(0, y), top); await page.waitForTimeout(40); }
}
async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await settle(page);
  expect(await axeViolations(page)).toEqual([]);
}
test('landing has static DNA, working anchors, readable responsive layout and honest preview', async ({ page }, info) => {
  await page.goto('/?mascot=centered');
  await expect(page.getByRole('heading', { name: 'A clearer view of your PGx reports.' })).toBeVisible();
  // Previous design-review URLs cannot override the approved layout.
  await expect(page.locator('[data-mascot-context="landing"]')).toHaveAttribute('data-mascot-variant', 'companion');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('600 32px Inter'))).toBe(true);
  await expect(page.locator('#home-title')).toHaveCSS('font-family', /Inter/);
  await expect(page.locator('.landing-hero-copy')).toHaveCSS('font-family', /Inter/);
  await expect(page.locator('header .font-heading')).toHaveCSS('font-family', /Poppins/);
  await expect(page.locator('footer')).toHaveCSS('font-family', /Inter/);
  const mark = page.getByRole('img', { name: 'Telesphoros shield and Rx logo' });
  expect((await mark.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.landing-dna')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.landing-dna img')).toHaveJSProperty('complete', true);
  expect(await page.locator('.landing-dna img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await page.locator('.landing-dna').evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  const illustrationRequests: string[] = [];
  page.on('request', request => { if (/\/api\//.test(request.url())) illustrationRequests.push(request.url()); });
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.locator('.workflow-file')).toContainText('SYN-002.json');
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Next: check', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Server verified', exact: true })).toBeVisible();
  const compare = page.getByRole('button', { name: 'Compare an incomplete upload', exact: true });
  await compare.focus(); await page.keyboard.press('Space');
  await expect(compare).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Not complete', exact: true })).toBeVisible();
  await checkLayout(page);
  await page.getByRole('region', { name: 'See whether the upload completed.' }).screenshot({ path: `../../docs/design/previews/workflow-verify-${info.project.name}.png` });
  await page.getByRole('button', { name: 'Find', exact: true }).focus();
  await page.keyboard.press('Enter');
  const incomplete = page.getByRole('button', { name: /SYN-002.json/ });
  await incomplete.focus(); await page.keyboard.press('Enter');
  await expect(incomplete).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#landing-file-detail').getByText('Upload not complete', { exact: true })).toBeVisible();
  await expect(page.locator('#landing-file-detail')).toContainText('Only metadata is available.');
  const verified = page.getByRole('button', { name: /SYN-001.vcf/ });
  await verified.focus(); await page.keyboard.press('Space');
  await expect(verified).toHaveAttribute('aria-pressed', 'true');
  await expect(incomplete).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#landing-file-detail')).toContainText('Yes — server verified');
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to the beginning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'VCF', exact: true }).click();
  expect(illustrationRequests).toEqual([]);
  await page.getByRole('region', { name: 'Add a report. Know what’s stored.' }).screenshot({ path: `../../docs/design/previews/workflow-${info.project.name}.png` });
  // Load the below-fold original artwork, and let every entrance run, before full-page evidence capture.
  await scrollThrough(page);
  await page.getByRole('img', { name: 'Telesphoros mascot in a teal cloak' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('img', { name: 'Telesphoros mascot in a teal cloak' })).toHaveJSProperty('naturalWidth', 162);
  await page.evaluate(() => window.scrollTo(0, 0));
  await checkLayout(page);
  await page.getByRole('region', { name: 'Working toward less trial-and-error prescribing.' }).screenshot({ path: `../../docs/design/previews/landing-purpose-${info.project.name}.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await page.screenshot({ path: `../../docs/design/previews/landing-${info.project.name}.png`, fullPage: true });
  await page.screenshot({ path: `../../docs/design/previews/landing-hero-${info.project.name}.png` });
  for (const [label, hash] of [['Workspace', '#platform'], ['Workflow', '#workflow'], ['FAQ', '#questions']]) {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label, exact: true }).click();
    expect(new URL(page.url()).hash).toBe(hash);
  }
  const question = page.locator('summary').filter({ hasText: 'Does the assistant interpret my reports?' });
  await question.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(/^No. The assistant interface is a separate local development preview/)).toBeVisible();
  await checkLayout(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(page.locator('.landing-dna')).toHaveCSS('animation-name', 'none');
  await checkLayout(page);
  for (const name of ['Check', 'Find']) {
    await page.getByRole('button', { name, exact: true }).click();
    await checkLayout(page);
  }
});
test('landing motion is decorative, finite and leaves a complete still page for reduced motion', async ({ page }, info) => {
  const apiRequests: string[] = [];
  page.on('request', request => { if (/\/api\//.test(request.url())) apiRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.product-landing')).toHaveClass(/is-motion/);
  // During the hero sequence: entrances move text but never fade it, so contrast is real at every frame.
  expect(await axeViolations(page)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'A clearer view of your PGx reports.' })).toBeVisible();
  await expect(page.locator('.landing-headline .landing-line')).toHaveCount(2);
  // Drawn elements are decoration only.
  expect(await page.locator('.landing-particles--hero .landing-particle').count()).toBeGreaterThan(20);
  await expect(page.locator('.landing-fragment')).toHaveCount(3);
  for (const element of await page.locator('.landing-particles, .landing-fragment').all()) await expect(element).toHaveAttribute('aria-hidden', 'true');
  // The approved artwork never moves.
  await expect(page.locator('.landing-dna')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.landing-dna img')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.mascot-welcome-image')).toHaveCSS('animation-name', 'none');
  expect(await page.locator('.landing-dna').evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  // Nothing repeats forever, and the time-based motion ends.
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  await settle(page);
  expect(await page.evaluate(() => new Promise<number>(resolve => {
    let shift = 0;
    new PerformanceObserver(list => { for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) shift += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => resolve(shift), 200);
  }))).toBeLessThan(0.01);
  // Reading down the page plays each fragment once; the assistant sample ends on its fixed, labelled answer.
  await scrollThrough(page);
  await page.locator('#platform').scrollIntoViewIfNeeded();
  await expect(page.locator('.landing-fragment-answer')).toBeVisible();
  await expect(page.locator('.landing-fragment-answer')).toHaveText('Sample response. Not connected to your reports.');
  // The walkthrough's digest is labelled fictional, and an incomplete upload has none.
  await page.locator('#workflow').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('.workflow-checklist')).toContainText('SHA-256 9f2c…41ad · fictional example');
  await page.getByRole('button', { name: 'Compare an incomplete upload', exact: true }).click();
  await expect(page.locator('.workflow-checklist')).toContainText('Not available');
  await checkLayout(page);
  await page.locator('#platform').screenshot({ path: `../../docs/design/previews/landing-fragments-${info.project.name}.png` });
  expect(apiRequests).toEqual([]);

  // Reduced motion: no motion layer, nothing animating, and every element in its final place.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A clearer view of your PGx reports.' })).toBeVisible();
  await expect(page.locator('.product-landing')).not.toHaveClass(/is-motion/);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(page.locator('.landing-fragment-answer')).toBeVisible();
  await expect(page.locator('.landing-fragment-typing')).toBeHidden();
  for (const selector of ['.landing-headline .landing-line > span', '.landing-fragment-wire', '.landing-fragment-answer', '.landing-particles--hero .landing-particle > span']) {
    for (const element of await page.locator(selector).all()) expect(await element.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  }
  await checkLayout(page);
});
test('landing sign-in works and returning home includes the brand header', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in to Telesphoros', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toHaveCSS('font-family', /Poppins/);
  await expect(page.locator('.landing-site-footer')).toHaveCount(0);
  await page.getByRole('link', { name: /Telesphoros shield and Rx logo/ }).click();
  await expect(page.getByRole('heading', { name: /A clearer view of/ })).toBeVisible();
  expect((await page.getByRole('img', { name: 'Telesphoros shield and Rx logo' }).boundingBox())!.y).toBeGreaterThanOrEqual(0);
});
test('reader sees the workflow but receives no upload action or live AI route', async ({ page }) => {
  await signInAs(page, 'bob', '/reports/upload');
  await expect(page.getByRole('heading', { name: 'You do not have access to this page' })).toBeVisible();
  await page.getByRole('link', { name: /Telesphoros shield and Rx logo/ }).click();
  await expect(page.getByRole('heading', { name: /A clearer view of/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Upload/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Explore the workflow', exact: true })).toHaveCount(2);
  await expect(page.locator('a[href="/local-interpretation"]')).toHaveCount(0);
});
