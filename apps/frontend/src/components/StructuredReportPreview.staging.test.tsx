import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReportDto, StructuredPreview } from '@telesphoros/shared-types';
import { StructuredReportPreview } from './StructuredReportPreview';
import { StructuredRevisionRecord } from './StructuredRevisionRecord';

// The synthetic staging build (VITE_SYNTHETIC_ASSESSMENT): the review UI on a deployed host, and the assessment section it adds to a saved revision.
const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['reviewer'] as string[] }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));

const laboratoryReport = JSON.parse(readFileSync('../../data/fixtures/pgx-contracts/uncertain/package.json', 'utf8')).report;
const report: ReportDto = {
  id: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
  type: 'structured',
  filename: 'package.json',
  sizeBytes: 100,
  status: 'received',
  fileUploaded: true,
  contentType: 'application/json',
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const decision = {
  id: '33333333-3333-4333-8333-333333333333',
  decision: 'verified',
  method: 'person-confirmed',
  basisCode: 'documented-clinic-procedure',
  createdAt: '2026-11-01T00:00:00Z',
};
const preview = {
  reportId: report.id,
  patientId: report.patientId,
  patientLabel: 'SYN-CASE',
  source: { sha256: report.sha256, objectVersion: 'version-one' },
  laboratoryReport,
  patientLink: { reportId: report.id, patientId: report.patientId, state: 'verified', decision, staleDecision: false },
  canReview: true,
  lineage: 'not-reconciled',
  synthetic: true,
  clinicalUse: 'not-approved',
  actionable: false,
} as unknown as StructuredPreview;
const savedRecord = (status: string) => ({
  reportId: report.id,
  patientId: report.patientId,
  record: {
    id: '44444444-4444-4444-8444-444444444444',
    reportId: report.id,
    laboratoryId: 'syn-lab-1',
    seriesId: 'syn-series-1',
    laboratoryReportId: 'syn-report-1',
    revision: 1,
    status: 'final',
    createdAt: '2026-11-02T00:00:00Z',
    findingIds: ['syn-finding-a'],
    currentBinding: true,
    selection: null,
  },
  history: [],
  state: 'candidate-for-review',
  reasons: [],
  review: { status, findings: [], outstanding: [], evidenceOnly: true },
  conflict: null,
  synthetic: true,
  clinicalUse: 'not-approved',
  actionable: false,
  independentReviewRequired: true,
});
const answer = (path: string, status = 'complete') => new Response(JSON.stringify(path.endsWith('/record') ? savedRecord(status) : preview), { status: 200 });

beforeEach(() => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  vi.stubGlobal('location', { hostname: 'app.staging.telesphoros.app' });
  auth.roles = ['reviewer'];
  auth.apiFetch.mockReset();
  auth.apiFetch.mockImplementation(async (path: string) => answer(path));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('opens the review of a structured report on a deployed host, which the owned-local rule would refuse, and shows the assessment once the review is complete', async () => {
  render(
    <MemoryRouter>
      <StructuredReportPreview report={report} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Show structured findings' }));
  await screen.findByText('SYN-CASE');
  expect(await screen.findByRole('region', { name: 'Synthetic assessment' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Run synthetic assessment' })).toBeEnabled();
});

it.each([
  ['the flag is false', 'false'],
  ['the flag is unset', ''],
])('is absent when %s (control: the same report opens in the staging build)', (_name, setting) => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', setting);
  const { container } = render(
    <MemoryRouter>
      <StructuredReportPreview report={report} />
    </MemoryRouter>,
  );
  expect(container).toBeEmptyDOMElement();
});

it.each([
  ['a PDF report', { ...report, type: 'lab-pdf' as const }],
  ['a report whose file is not uploaded', { ...report, fileUploaded: false }],
])('stays closed for %s', (_name, other) => {
  const { container } = render(
    <MemoryRouter>
      <StructuredReportPreview report={other} />
    </MemoryRouter>,
  );
  expect(container).toBeEmptyDOMElement();
});

it('does not offer the assessment in a build without the flag, even where the record component runs (the owned-local build)', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'false');
  render(
    <MemoryRouter>
      <StructuredRevisionRecord preview={preview} />
    </MemoryRouter>,
  );
  await screen.findByText('Saved · ready for findings review');
  expect(screen.queryByRole('region', { name: 'Synthetic assessment' })).not.toBeInTheDocument();
});

it('does not enable the assessment while findings still await review', async () => {
  auth.apiFetch.mockImplementation(async (path: string) => answer(path, 'awaiting-review'));
  render(
    <MemoryRouter>
      <StructuredRevisionRecord preview={preview} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('region', { name: 'Synthetic assessment' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Run synthetic assessment' })).toBeDisabled();
});
