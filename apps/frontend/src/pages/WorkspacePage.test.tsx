import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportStatus, Role } from '@telesphoros/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { useSyntheticChat } from '@/hooks/useSyntheticChat';
import { submitReport } from '@/lib/api';

// The sample engine must never be reached from the production workspace (spec 024 CH-5): both entry points are replaced by spies.
vi.mock('@/hooks/useSyntheticChat', () => ({ useSyntheticChat: vi.fn() }));
vi.mock('@/lib/syntheticChatTransport', () => ({ createSyntheticChatTransport: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), submitReport: vi.fn() }));

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const REPORT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const report = (status: ReportStatus) => ({
  id: REPORT_ID,
  patientId: PATIENT.id,
  type: 'structured',
  filename: 'SYN-004-cyp2c19.json',
  sizeBytes: 18,
  status,
  fileUploaded: true,
  contentType: 'application/json',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
});
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });

let listed: ReportStatus = 'received';
function api(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients')
      ? page([PATIENT])
      : url.includes('/api/v1/reports')
        ? page([report(listed)])
        : url.endsWith('/api/v1/me/recovery-scope')
          ? { recoveryScope: RECOVERY_SCOPE }
          : { roles };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}
const open = (roles: Role[], path = '/workspace') => renderApp(path, { signedInAs: roles, fetchImpl: api(roles) as unknown as typeof fetch });
const json = () => new File(['{"synthetic":true}'], 'SYN-004-cyp2c19.json');
const file = () => document.querySelector<HTMLInputElement>('input[type=file]')!;
const CONFIRM = { name: 'I confirm this file contains synthetic data only' };
const NOTE = 'Interpretation is not available in the prototype yet.';
const conversation = () => screen.findByRole('region', { name: 'Conversation' });

beforeEach(() => {
  listed = 'received';
  vi.mocked(submitReport).mockResolvedValue({ reference: REPORT_ID });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('the chat-first home in every build (specs/024)', () => {
  it('renders on a host that is not the local preview, with the empty-state heading and the synthetic notice (CH-1)', async () => {
    open(['clinician']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' })).toBeVisible();
    expect(screen.getByText('Synthetic data only. Not for clinical use.')).toBeVisible();
    // In the shared frame: the feature panel is there, the local preview's own frame is not.
    expect(document.querySelector('header.workspace-navigation')).not.toBeNull();
  });

  it('is open to a member with no role, who can type but not attach', async () => {
    open([]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Attach a report' })).toBeNull();
  });

  it('signing in from the home page lands on /workspace for a clinical role, and an administrator stays on the home page (CH-1, D6)', async () => {
    const clinician = open(['clinician'], '/');
    await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' });
    expect(clinician.router.state.location.pathname).toBe('/workspace');
    clinician.unmount();
    const admin = open(['admin'], '/');
    await waitFor(() => expect(admin.client.completeSignIn).toHaveBeenCalled());
    await screen.findByRole('main');
    await waitFor(() => expect(admin.router.state.location.pathname).toBe('/'));
  });

  it('shows a typed question as a note, never an answer, and makes no network request (CH-4)', async () => {
    const { fetchImpl } = open(['clinician']);
    const box = await screen.findByRole('textbox', { name: 'Question' });
    await screen.findByRole('button', { name: 'Attach a report' });
    const before = fetchImpl.mock.calls.length;
    await userEvent.type(box, 'What does CYP2C19 *2/*2 mean?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(NOTE)).toBeVisible();
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    expect(screen.getByText('What does CYP2C19 *2/*2 mean?')).toBeVisible();
    expect(fetchImpl.mock.calls.length).toBe(before);
    expect(screen.queryByText(/Sample answer/)).toBeNull();
  });

  it('never reaches the sample engine, and offers no sample-question buttons (CH-5)', async () => {
    open(['clinician']);
    await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Question' }), 'Explain this example');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(NOTE);
    expect(screen.queryByRole('group', { name: 'Sample questions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Explain this' })).toBeNull();
    expect(useSyntheticChat).not.toHaveBeenCalled();
  });

  it('needs the synthetic confirmation before it sends (D5)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Confirm the file is synthetic.')).toBeVisible();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('sends an attached JSON report once, with the confirmation, and shows it with its status word (CH-3)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const thread = within(await conversation());
    expect(await thread.findByText(/SYN-004-cyp2c19\.json/)).toBeVisible();
    expect(await thread.findByText('Received')).toHaveClass('text-warning');
    expect(submitReport).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(submitReport).mock.calls[0]![0];
    expect(sent).toMatchObject({ patientId: PATIENT.id, reportType: 'structured', syntheticConfirmed: true });
    expect(sent.file.name).toBe('SYN-004-cyp2c19.json');
  });

  it('"Check status" reloads the report from the list and shows its new status word (CH-3)', async () => {
    const { fetchImpl } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await screen.findByRole('combobox', { name: 'Patient' });
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const thread = within(await conversation());
    await thread.findByText('Received');
    listed = 'processed';
    const reads = () => fetchImpl.mock.calls.filter(([input]) => String(input).includes('/api/v1/reports')).length;
    const before = reads();
    await userEvent.click(thread.getByRole('button', { name: 'Check status' }));
    expect(await thread.findByText('Processed')).toHaveClass('text-success');
    expect(reads()).toBeGreaterThan(before);
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it('refuses a PDF without owned-storage mode, naming the local preview, and uploads nothing (CH-6, D4)', async () => {
    const { fetchImpl } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), new File(['%PDF-1.4'], 'SYN-004.pdf', { type: 'application/pdf' }), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(/local preview/i);
    await userEvent.click(await screen.findByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(submitReport).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('refuses any other file type, as the Upload page does (CH-6)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), new File(['##fileformat=VCFv4.2\n'], 'SYN-004.vcf'), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Raw genomic data (VCF) is not accepted.');
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('"New chat" starts an empty conversation', async () => {
    open(['clinician']);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Question' }), 'First question');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(NOTE);
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'New chat' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' })).toBeVisible();
    expect(screen.queryByText('First question')).toBeNull();
  });
  it("a patient added in the panel appears in the chat's patient choice (CH-9)", async () => {
    const created = { ...PATIENT, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-777' };
    const base = api(['clinician']);
    const impl = vi.fn<typeof fetch>(async (input, init) =>
      String(input).includes('/api/v1/patients') && init?.method === 'POST'
        ? new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } })
        : base(input, init),
    );
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await screen.findByRole('combobox', { name: 'Patient' });
    const patients = within(await screen.findByRole('region', { name: 'Patients' }));
    await userEvent.click(patients.getByRole('button', { name: 'Add patient' }));
    await userEvent.type(patients.getByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
    await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
    expect(await within(screen.getByRole('combobox', { name: 'Patient' })).findByRole('option', { name: 'SYN-777' })).toBeInTheDocument();
  });
});
