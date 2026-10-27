import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@telesphoros/shared-types';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { ownedStorageMode } from '@/lib/storageMode';

// The published build: VITE_LOCAL_STORAGE_INTAKE is unset (scripts/staging/publish-frontend.sh refuses it), so nothing here mocks the storage mode.
// Reports come from the deployed API; file downloads stay with the owned-storage build, the only one given storage origins.
const date = '2026-10-12T00:00:00Z';
const row = {
  id: '33333333-3333-4333-8333-333333333333',
  patientId: '11111111-1111-4111-8111-111111111111',
  type: 'vcf',
  filename: 'synthetic.vcf',
  sizeBytes: 8,
  status: 'received',
  fileUploaded: true,
  contentType: 'text/x-vcf',
  sha256: 'a'.repeat(64),
  createdAt: date,
  updatedAt: date,
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function api(roles: Role[]) {
  const asked: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (url.pathname.endsWith('/me')) return json({ roles });
    if (url.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (url.pathname.endsWith('/patients'))
      return json({ data: [{ id: row.patientId, label: 'SYN-1', createdAt: date, updatedAt: date }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    if (url.pathname === '/api/v1/reports') return json({ data: [row], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    return json({ message: 'not expected' }, 500);
  });
  return { fetchImpl, asked };
}
const heading = () => screen.findByRole('heading', { level: 1, name: 'Reports' });

describe('the reports page in the published build', () => {
  it('is a published build (control: the owned-storage setting is off)', () => {
    expect(ownedStorageMode()).toBe(false);
  });

  it('lists the organization’s reports from the API and opens their details', async () => {
    const { fetchImpl, asked } = api(['clinician']);
    const { container } = renderApp('/reports', { signedInAs: ['clinician'], fetchImpl });
    await heading();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    const detail = within(screen.getByRole('region', { name: 'Report details' }));
    expect(detail.getByText('Yes — server verified')).toBeInTheDocument();
    expect(asked).toContain('/api/v1/reports');
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([['clinician'], ['reviewer']] as Role[][])('offers no file download to %s, says so quietly, and never asks for a file link', async (role) => {
    const { fetchImpl, asked } = api([role]);
    renderApp('/reports', { signedInAs: [role], fetchImpl });
    await heading();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    expect(screen.queryByRole('button', { name: 'Download synthetic.vcf' })).not.toBeInTheDocument();
    expect(screen.getByText('File downloads are not available in this build.')).toBeInTheDocument();
    expect(asked.some((path) => path.endsWith('/download-url'))).toBe(false);
  });

  it('keeps a reader to metadata', async () => {
    renderApp('/reports', { signedInAs: ['reader'], fetchImpl: api(['reader']).fetchImpl });
    await heading();
    expect(screen.getByText('Your role can view report metadata only.')).toBeInTheDocument();
  });

  it('refuses an administrator who holds no clinical role', async () => {
    renderApp('/reports', { signedInAs: ['admin'], fetchImpl: api(['admin']).fetchImpl });
    expect(await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeInTheDocument();
  });

  it('links Reports from the workspace navigation for a clinical role', async () => {
    renderApp('/reports/upload', { signedInAs: ['clinician'], fetchImpl: api(['clinician']).fetchImpl });
    await screen.findByRole('button', { name: 'Workspace navigation' }); // the sidebar has replaced the header (both name their links Primary)
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(primary).findByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
  });

  it('links Reports from the site header outside the workspace', async () => {
    renderApp('/signed-out', { signedInAs: ['clinician'], fetchImpl: api(['clinician']).fetchImpl });
    const banner = await screen.findByRole('banner');
    expect(await within(banner).findByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
  });
});
