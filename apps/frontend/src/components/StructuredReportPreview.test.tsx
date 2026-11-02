import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { ReportDto } from '@telesphoros/shared-types';
import { StructuredReportPreview } from './StructuredReportPreview';
const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['reviewer'] }));
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
const preview = () => ({
  reportId: report.id,
  patientId: report.patientId,
  patientLabel: 'SYN-CASE',
  source: { sha256: report.sha256, objectVersion: 'version-one' },
  laboratoryReport,
  patientLink: { reportId: report.id, patientId: report.patientId, state: 'unverified', decision: null, staleDecision: false },
  canReview: true,
  lineage: 'not-reconciled',
  synthetic: true,
  clinicalUse: 'not-approved',
  actionable: false,
});
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  auth.roles = ['reviewer'];
  auth.apiFetch.mockReset();
  auth.apiFetch.mockImplementation(async () => response(preview()));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'Show structured findings' }));
  await screen.findByText('SYN-CASE');
}
it('loads on demand, preserves uncertainty, and requires a reason and explicit confirmation', async () => {
  const { container } = render(<StructuredReportPreview report={report} />);
  expect(auth.apiFetch).not.toHaveBeenCalled();
  await open();
  expect(screen.getByRole('list', { name: 'Laboratory findings' })).toHaveTextContent('ambiguous');
  expect(screen.getByText(/Candidates:/)).toBeVisible();
  expect(screen.queryByText(/Synthetic example: review the invented finding/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Review patient link'));
  const save = screen.getByRole('button', { name: 'Record patient-link decision' });
  expect(save).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText('Reason for decision'), 'documented-clinic-procedure');
  expect(save).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox'));
  expect(save).toBeEnabled();
  expect(await axe(container)).toHaveNoViolations();
  const decision = {
    id: '33333333-3333-4333-8333-333333333333',
    decision: 'verified',
    method: 'person-confirmed',
    basisCode: 'documented-clinic-procedure',
    createdAt: '2026-11-01T00:00:00Z',
  };
  auth.apiFetch.mockResolvedValueOnce(response(decision)).mockResolvedValueOnce(response({ ...preview(), patientLink: { ...preview().patientLink, state: 'verified', decision } }));
  await userEvent.click(save);
  await screen.findByText(/Patient-link decision recorded/);
  const post = auth.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1].body)).toEqual({
    patientId: report.patientId,
    sha256: report.sha256,
    objectVersion: 'version-one',
    sourcePatientReference: laboratoryReport.patientId,
    decision: 'verified',
    basisCode: 'documented-clinic-procedure',
  });
  expect(screen.getByText('verified', { exact: true })).toBeVisible();
});
it('hides review actions for the uploader or a clinician', async () => {
  auth.roles = ['clinician'];
  auth.apiFetch.mockResolvedValue(response({ ...preview(), canReview: false }));
  render(<StructuredReportPreview report={report} />);
  await open();
  expect(screen.queryByText('Review patient link')).not.toBeInTheDocument();
  expect(screen.getByText(/An independent reviewer/)).toBeVisible();
});
it('clears uncertain mutation results and reloads before another decision', async () => {
  render(<StructuredReportPreview report={report} />);
  await open();
  await userEvent.click(screen.getByText('Review patient link'));
  await userEvent.selectOptions(screen.getByLabelText('Reason for decision'), 'documented-clinic-procedure');
  await userEvent.click(screen.getByRole('checkbox'));
  auth.apiFetch.mockRejectedValueOnce(new Error('offline'));
  await userEvent.click(screen.getByRole('button', { name: 'Record patient-link decision' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('may already be recorded');
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reload findings' }));
  await screen.findByText('SYN-CASE');
  expect(screen.queryByText(/decision recorded/)).not.toBeInTheDocument();
});
it('aborts and discards late reads when switching reports', async () => {
  let finish!: (r: Response) => void;
  auth.apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender } = render(<StructuredReportPreview report={report} />);
  await userEvent.click(screen.getByRole('button', { name: 'Show structured findings' }));
  const signal = auth.apiFetch.mock.calls[0]![1].signal as AbortSignal;
  rerender(<StructuredReportPreview report={{ ...report, id: '44444444-4444-4444-8444-444444444444' }} />);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(response(preview()));
  });
  expect(screen.queryByText('SYN-CASE')).not.toBeInTheDocument();
});
it('offers a retry after failed reads without showing raw server content', async () => {
  auth.apiFetch.mockResolvedValueOnce(new Response('untrusted-private-detail', { status: 422 }));
  render(<StructuredReportPreview report={report} />);
  await userEvent.click(screen.getByRole('button', { name: 'Show structured findings' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('untrusted-private-detail')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reload findings' }));
  await waitFor(() => expect(screen.getByText('SYN-CASE')).toBeVisible());
});
it.each(['reader', 'admin'])('excludes %s roles', (role) => {
  auth.roles = [role];
  const { container } = render(<StructuredReportPreview report={report} />);
  expect(container).toBeEmptyDOMElement();
});
it.each([
  { mode: 'false', host: '127.0.0.1' },
  { mode: 'true', host: 'example.test' },
])('excludes ordinary builds and remote hosts: %j', ({ mode, host }) => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', mode);
  vi.stubGlobal('location', { hostname: host });
  const { container } = render(<StructuredReportPreview report={report} />);
  expect(container).toBeEmptyDOMElement();
});

it('labels declared amendments as unreconciled and preserves their source revision', async () => {
  const amended = JSON.parse(readFileSync('../../data/fixtures/pgx-contracts/amended/package.json', 'utf8')).report;
  auth.apiFetch.mockResolvedValue(response({ ...preview(), laboratoryReport: amended }));
  render(<StructuredReportPreview report={report} />);
  await open();
  expect(screen.getByText(/Revision 2/)).toBeVisible();
  expect(screen.getByText(/Revision lineage has not been reconciled/)).toHaveTextContent(amended.previousRevisionId);
});
