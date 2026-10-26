import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { ReportDto } from '@telesphoros/shared-types';
import { ReportDetails } from './ReportDetails';

const date = '2026-10-26T00:00:00Z';
const report: ReportDto = {
  id: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
  type: 'lab-pdf',
  filename: 'renamed-example.pdf',
  sizeBytes: 934,
  status: 'received',
  fileUploaded: true,
  contentType: 'application/pdf',
  sha256: 'fd2b6475143803a2add6446de753cbbe61879b567fa016b10434d7b5d38aac14',
  createdAt: date,
  updatedAt: date,
};
const held = 'ae0da40e71aeef9ef9b1b8ca306e7d0a24aecd77ed1ea974d0695e431e8c7289';
const view = (value: ReportDto = report) => <ReportDetails report={value} patientLabel="SYN-DEMO" canDownload={false} downloading={null} onDownload={vi.fn()} />;
beforeEach(() => {
  vi.stubEnv('VITE_SYNTHETIC_PGX_DEMO', 'true');
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('shows only fixed D01 values with source disclosure and no network work', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { container } = render(view());
  expect(screen.queryByRole('heading', { name: 'Sample result' })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show fixed sample result' }));
  expect(screen.getByRole('heading', { name: 'Sample result' })).toBeVisible();
  const table = screen.getByRole('table', { name: 'Fixed gene findings' });
  expect(within(table).getByRole('row', { name: 'CYP2C19 *1/*2' })).toBeVisible();
  expect(within(table).getByRole('row', { name: 'CYP2B6 *1/*1' })).toBeVisible();
  expect(screen.getByText('Q intermediate.')).toBeVisible();
  expect(screen.getByText(/invented test values, not CPIC guidance/)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  expect(await axe(container)).toHaveNoViolations();
});

it('shows the fixed held case without a gene or drug result', async () => {
  const { container } = render(view({ ...report, sha256: held, sizeBytes: 899 }));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show held sample' }));
  expect(screen.getByRole('heading', { name: 'Sample held' })).toBeVisible();
  expect(screen.getByText('Sample reason: alignment-unsupported')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('Test Drug Q')).not.toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

it.each([{ filename: 'source.pdf', sha256: 'a'.repeat(64) }, { sha256: null }, { fileUploaded: false }])(
  'does not infer a sample from filename or incomplete/unrecognized storage: %j',
  (change) => {
    render(view({ ...report, ...change }));
    expect(screen.queryByRole('button', { name: /Show.*sample/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Q intermediate.')).not.toBeInTheDocument();
  },
);

it.each([
  { flag: '', storage: 'true', host: '127.0.0.1' },
  { flag: 'false', storage: 'true', host: '127.0.0.1' },
  { flag: 'true', storage: 'false', host: '127.0.0.1' },
  { flag: 'true', storage: 'true', host: 'localhost' },
  { flag: 'true', storage: 'true', host: 'example.com' },
])('does not expose the demo outside its opted-in loopback build: %j', ({ flag, storage, host }) => {
  vi.stubEnv('VITE_SYNTHETIC_PGX_DEMO', flag);
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', storage);
  vi.stubGlobal('location', { hostname: host });
  render(view());
  expect(screen.queryByRole('region', { name: 'Fixed synthetic PGx demo' })).not.toBeInTheDocument();
});

it('resets an opened result when the selected stored file changes', async () => {
  const { rerender } = render(view());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show fixed sample result' }));
  rerender(view({ ...report, sha256: held }));
  expect(screen.queryByText('Q intermediate.')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Sample held' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show held sample' })).toHaveAttribute('aria-expanded', 'false');
});
