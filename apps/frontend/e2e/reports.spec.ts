import { expect, test } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInAs, signInWithPatient } from './helpers';

// The published-style build (no owned-storage setting): a clinician reaches Reports from the navigation and finds what they uploaded, read
// from the API. File download is not offered here: signed links need the owned-storage build's configured storage origins.
test('a clinician opens Reports from the navigation and finds the report they uploaded, without a file download', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const name = `synthetic-${crypto.randomUUID().slice(0, 8)}.vcf`;
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('vcf');
  await page.getByLabel(/report file/i).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n') });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();

  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  const links: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/download-url')) links.push(request.url());
  });
  await selectReportsPatient(page, fixture); // the suite shares one organization, so its first page may hold other tests' reports
  await page.getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.getByRole('region', { name: 'Report details' }).getByText('Yes — server verified')).toBeVisible();
  await expect(page.getByRole('button', { name: `Download ${name}` })).toHaveCount(0);
  await expect(page.getByText('File downloads are not available in this build.')).toBeVisible();
  expect(links).toEqual([]);
});

test('an administrator with no clinical role is refused Reports, as the API would refuse the list', async ({ page }) => {
  await signInAs(page, 'carol', '/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeVisible();
});
