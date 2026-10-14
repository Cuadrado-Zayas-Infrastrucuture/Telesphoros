import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './helpers';
const require = createRequire(import.meta.url);
async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected in the test only.
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((item: { id: string; nodes: { target: string[] }[] }) => ({ id: item.id, targets: item.nodes.map(node => node.target) }));
  });
  expect(violations).toEqual([]);
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
  // Load the below-fold original artwork before full-page evidence capture.
  await page.getByRole('img', { name: 'Telesphoros mascot in a teal cloak' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('img', { name: 'Telesphoros mascot in a teal cloak' })).toHaveJSProperty('naturalWidth', 162);
  await page.evaluate(() => window.scrollTo(0, 0));
  await checkLayout(page);
  await page.getByRole('region', { name: 'Working toward less trial-and-error prescribing.' }).screenshot({ path: `../../docs/design/previews/landing-purpose-${info.project.name}.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
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
