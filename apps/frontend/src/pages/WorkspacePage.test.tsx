import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportStatus, Role } from '@telesphoros/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { useSyntheticChat } from '@/hooks/useSyntheticChat';
import { SubmitError, submitReport } from '@/lib/api';
import { cancelOwnedUpload, removeUnfinishedReport } from '@/lib/ownedStorageApi';

// The sample engine must never be reached from the production workspace (spec 024 CH-5): both entry points are replaced by spies.
vi.mock('@/hooks/useSyntheticChat', () => ({ useSyntheticChat: vi.fn() }));
vi.mock('@/lib/syntheticChatTransport', () => ({ createSyntheticChatTransport: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), submitReport: vi.fn() }));
// The server-side cancel and the removal have their own tests (ownedStorageApi.test.ts); here only what the chat asks for, and when.
vi.mock('@/lib/ownedStorageApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ownedStorageApi')>()),
  cancelOwnedUpload: vi.fn(),
  removeUnfinishedReport: vi.fn(),
}));

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const REPORT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const report = (status: ReportStatus, fileUploaded = true) => ({
  id: REPORT_ID,
  patientId: PATIENT.id,
  type: 'structured',
  filename: 'SYN-004-cyp2c19.json',
  sizeBytes: 18,
  status,
  fileUploaded,
  contentType: 'application/json',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
});
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });

let listed: ReportStatus = 'received';
let listedUploaded = true;
function api(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients')
      ? page([PATIENT])
      : url.endsWith(`/api/v1/reports/${REPORT_ID}`)
        ? report(listed, listedUploaded)
        : url.includes('/api/v1/reports')
          ? page([report(listed, listedUploaded)])
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
  listedUploaded = true;
  vi.mocked(submitReport).mockResolvedValue({ reference: REPORT_ID });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Settings sits in the account menu at the sidebar's foot (specs/034 D4). */
async function openSettings() {
  await userEvent.click(screen.getByRole('button', { name: /^Account, / }));
  await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
}
/** Add patient is on the Patients page (specs/034 D2). */
async function addPatientFromSidebar() {
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Patients' }));
  await userEvent.click(await screen.findByRole('link', { name: 'Add patient' }));
}

describe('the chat-first home in every build (specs/024)', () => {
  it('uses a preferred name set in account preferences for the chat welcome', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await openSettings();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Preferred name' }), 'Avery');
    await userEvent.click(screen.getByRole('button', { name: 'Save preferred name' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close account preferences' }));
    expect(await screen.findByText('Welcome, Avery.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Start with a synthetic report.' })).toBeVisible();
  });

  it('shows a generic welcome when a preferred name has not been set', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    expect(screen.getByText('Welcome.')).toBeVisible();
  });

  it('opens patient creation on the patient page instead of inside chat', async () => {
    const { router } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await addPatientFromSidebar();
    await waitFor(() => expect(router.state.location.pathname).toBe('/patients/new'));
    expect(await screen.findByRole('heading', { name: 'New patient' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Given name' })).toBeVisible();
  });

  it('preserves the unsent question and attachment across patient creation navigation', async () => {
    const { router } = open(['clinician']);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Question' }), 'Keep this draft');
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await addPatientFromSidebar();
    await screen.findByRole('heading', { name: 'New patient' });
    await userEvent.click(screen.getByRole('link', { name: 'Back to chat' }));
    expect(router.state.location.pathname).toBe('/workspace');
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Report details' })).toHaveTextContent('SYN-004-cyp2c19.json');
    expect(submitReport).not.toHaveBeenCalled();
  });

  it.each([
    ['Reports', 'Report history'],
    ['Settings', 'Account preferences'],
  ])('opens %s over chat and keeps the draft when closed', async (link, title) => {
    open(['clinician']);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Question' }), 'Keep my draft');
    if (link === 'Settings') await openSettings();
    else await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: link }));
    const panel = await screen.findByRole('dialog', { name: title });
    await userEvent.click(within(panel).getByRole('button', { name: `Close ${title.toLowerCase()}` }));
    expect(await screen.findByRole('textbox', { name: 'Question' })).toHaveValue('Keep my draft');
  });

  it('keeps a report note with its upload without treating it as an interpretation question', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.type(screen.getByRole('textbox', { name: 'Report note' }), 'Review at next visit');
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const thread = within(await conversation());
    expect(await thread.findByText('Received')).toBeVisible();
    expect(thread.getByText('Review at next visit')).toBeVisible();
    expect(thread.queryByText(NOTE)).toBeNull();
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it('shows a failed upload inside the reopened details dialog and retains its note for retry', async () => {
    vi.mocked(submitReport).mockRejectedValueOnce(new Error('outside-response-not-for-display'));
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.type(screen.getByRole('textbox', { name: 'Report note' }), 'Keep this upload note');
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const details = within(await screen.findByRole('dialog', { name: 'Report details' }));
    expect(await details.findByRole('alert')).toHaveTextContent('The upload was interrupted. Your file is kept; please retry.');
    expect(details.getByRole('textbox', { name: 'Report note' })).toHaveValue('Keep this upload note');
    expect(screen.queryByText('outside-response-not-for-display')).toBeNull();
    await userEvent.click(details.getByRole('button', { name: 'Upload report' }));
    expect(await within(await conversation()).findByText('Received')).toBeVisible();
    expect(submitReport).toHaveBeenCalledTimes(2);
  });

  it('removes an attached file from its chip in the message box, with Undo', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    const form = within(screen.getByRole('form', { name: 'Report and question' }));
    await userEvent.click(form.getByRole('button', { name: 'Remove SYN-004-cyp2c19.json' }));
    expect(form.queryByRole('button', { name: 'Report details' })).not.toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Undo attachment removal' })).toBeVisible();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('cancels a failed upload: the server cancels the attempt first, then the report that never got its file is removed', async () => {
    vi.mocked(submitReport).mockImplementationOnce(async (_values, _api, progress) => {
      progress.reportId = REPORT_ID;
      throw new Error('outside-response-not-for-display');
    });
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const details = within(await screen.findByRole('dialog', { name: 'Report details' }));
    await details.findByRole('alert');
    await userEvent.click(details.getByRole('button', { name: 'Cancel upload' }));
    expect(await within(await conversation()).findByText('Upload cancelled and removed from your reports.')).toBeVisible();
    expect(vi.mocked(cancelOwnedUpload).mock.calls[0]![1]).toMatchObject({ reportId: REPORT_ID });
    expect(removeUnfinishedReport).toHaveBeenCalledWith(expect.any(Function), REPORT_ID);
    expect(vi.mocked(cancelOwnedUpload).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(removeUnfinishedReport).mock.invocationCallOrder[0]!);
    const form = within(screen.getByRole('form', { name: 'Report and question' }));
    expect(form.queryByRole('button', { name: 'Report details' })).not.toBeInTheDocument();
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it('keeps the report, and says why, when the server does not acknowledge the cancel', async () => {
    vi.mocked(submitReport).mockImplementationOnce(async (_values, _api, progress) => {
      progress.reportId = REPORT_ID;
      throw new Error('outside-response-not-for-display');
    });
    vi.mocked(cancelOwnedUpload).mockRejectedValueOnce(new SubmitError('Cancellation is pending. Retry cancellation before starting over.'));
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const details = within(await screen.findByRole('dialog', { name: 'Report details' }));
    await details.findByRole('alert');
    await userEvent.click(details.getByRole('button', { name: 'Cancel upload' }));
    expect(await details.findByText('Cancellation is pending. Retry cancellation before starting over.')).toBeVisible();
    expect(removeUnfinishedReport).not.toHaveBeenCalled();
    expect(details.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
  });

  it('offers no cancel for an upload that has not failed', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    expect(within(screen.getByRole('dialog', { name: 'Report details' })).queryByRole('button', { name: 'Cancel upload' })).not.toBeInTheDocument();
  });

  it('says "Upload not finished" for a recent report whose file never arrived, and removes it after a second step', async () => {
    listedUploaded = false;
    open(['clinician']);
    const list = within(await screen.findByRole('list', { name: 'Recent reports' })); // specs/034 D3: the former Past reports
    expect(await list.findByText('Upload not finished')).toBeVisible();
    expect(list.queryByText('Received')).not.toBeInTheDocument();
    await userEvent.click(list.getByRole('button', { name: 'Remove unfinished upload SYN-004-cyp2c19.json' }));
    expect(removeUnfinishedReport).not.toHaveBeenCalled();
    await userEvent.click(within(list.getByRole('group', { name: 'Remove unfinished upload SYN-004-cyp2c19.json?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeUnfinishedReport).toHaveBeenCalledWith(expect.any(Function), REPORT_ID));
  });

  it.each(['reader', 'reviewer'] as const)('offers a %s no removal: the API lets only a clinician remove a report', async (role) => {
    listedUploaded = false;
    open([role]);
    const list = within(await screen.findByRole('list', { name: 'Recent reports' }));
    expect(await list.findByText('Upload not finished')).toBeVisible(); // the row is there: only the action is withheld
    expect(list.queryByRole('button', { name: /^Remove unfinished upload/ })).not.toBeInTheDocument();
  });

  it('offers no removal for a recent report whose file is stored', async () => {
    open(['clinician']);
    const list = within(await screen.findByRole('list', { name: 'Recent reports' })); // specs/034 D3: the former Past reports
    expect(await list.findByText('Received')).toBeVisible();
    expect(list.queryByRole('button', { name: /^Remove unfinished upload/ })).not.toBeInTheDocument();
  });

  it('requires fresh confirmation after replacing a file', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.upload(file(), new File(['{}'], 'replacement.json'));
    expect(screen.getByRole('checkbox', CONFIRM)).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('can select the same file again after removing it', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    const selected = json();
    await userEvent.upload(file(), selected);
    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await userEvent.upload(file(), selected);
    expect(await screen.findByRole('dialog', { name: 'Report details' })).toBeVisible();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('loads later patients for an attachment, retries a failed page and retains the selected patient', async () => {
    const other = { ...PATIENT, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-LATER' };
    const base = api(['clinician']);
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/patients' && !init?.method) {
        const next = url.searchParams.get('page') === '2';
        if (next && fail) return new Response('{}', { status: 503 });
        return new Response(JSON.stringify({ data: [next ? other : PATIENT], meta: { page: next ? 2 : 1, pageSize: 20, total: 21, totalPages: 2 } }));
      }
      return base(input, init);
    });
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    const details = within(await screen.findByRole('dialog', { name: 'Report details' }));
    await userEvent.click(details.getByRole('button', { name: 'More patients' }));
    expect(await details.findByRole('alert')).toHaveTextContent(/patients/i);
    expect(details.getByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    fail = false;
    await userEvent.click(details.getByRole('button', { name: 'Retry loading patients' }));
    expect(await details.findByRole('option', { name: 'SYN-LATER' })).toBeInTheDocument();
    expect(details.getByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.selectOptions(details.getByRole('combobox', { name: 'Patient' }), other.id);
    await userEvent.click(details.getByRole('checkbox', CONFIRM));
    await userEvent.click(details.getByRole('button', { name: 'Upload report' }));
    await waitFor(() => expect(submitReport).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitReport).mock.calls[0]![0].patientId).toBe(other.id);
  });

  it('opens report details over chat on attachment without starting an upload', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    const details = await screen.findByRole('dialog', { name: 'Report details' });
    expect(within(details).getByRole('combobox', { name: 'Patient' })).toBeVisible();
    expect(within(details).getByRole('checkbox', CONFIRM)).not.toBeChecked();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('keeps a dismissed attachment and requires its details to be confirmed before uploading', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await screen.findByRole('dialog', { name: 'Report details' });
    await userEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.queryByRole('dialog', { name: 'Report details' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Report details' }));
    const details = await screen.findByRole('dialog', { name: 'Report details' });
    await userEvent.click(within(details).getByRole('checkbox', CONFIRM));
    await userEvent.click(within(details).getByRole('button', { name: 'Upload report' }));
    expect(await within(await conversation()).findByText('Received')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Report details' })).toBeNull();
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

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

  it('opens the patient page from report details and explains the label rules there', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Report details' })).getByRole('link', { name: 'Add patient' }));
    expect(await screen.findByRole('textbox', { name: 'Synthetic patient label' })).toHaveAccessibleDescription('Letters, numbers and hyphens. A code, never a name.');
  });

  it('locks patient creation, retries with the same identity and returns to the attachment to upload once', async () => {
    const requests: Array<{ label: string; requestId: string }> = [];
    const replies: Array<(response: Response) => void> = [];
    const ok = api(['clinician']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/api/v1/patients') && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => replies.push(resolve));
      }
      return ok(input, init);
    });
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Report details' })).getByRole('link', { name: 'Add patient' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-NEW');
    await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const pending = screen.getByRole('button', { name: 'Saving…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('textbox', { name: 'Synthetic patient label' })).toHaveAttribute('readonly');
    fireEvent.submit(pending.closest('form')!);
    expect(requests).toHaveLength(1);
    await act(async () => replies[0]!(new Response('{}', { status: 503 })));
    expect(await screen.findByRole('alert')).toHaveTextContent(/patient/i);
    expect(submitReport).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => replies[1]!(new Response(JSON.stringify({ ...PATIENT, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-NEW' }), { status: 201 })));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Synthetic patient label' })).toBeNull());
    await userEvent.click(await screen.findByRole('link', { name: 'Back to chat' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Report details' }));
    expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveValue('1a8fad5b-d9cb-469f-a165-70867728950f');
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(await within(await conversation()).findByText('Received')).toBeVisible();
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it('can undo removing an unsent attachment without losing the selected patient or note, and sends nothing by itself', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    const form = within(screen.getByRole('form', { name: 'Report and question' }));
    await userEvent.type(form.getByRole('textbox', { name: 'Question' }), 'Keep this note');
    await userEvent.click(form.getByRole('button', { name: 'Remove file' }));
    expect(form.queryByText('SYN-004-cyp2c19.json')).not.toBeInTheDocument();
    const undo = form.getByRole('button', { name: 'Undo attachment removal' });
    expect(undo.closest('[role="status"]')).toHaveTextContent('Attachment removed.');
    await userEvent.click(undo);
    expect(form.getByText('SYN-004-cyp2c19.json')).toBeVisible();
    expect(form.getByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    expect(form.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep this note');
    expect(form.queryByRole('button', { name: 'Undo attachment removal' })).not.toBeInTheDocument();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('expires the attachment Undo after eight seconds', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    act(() => vi.advanceTimersByTime(7_999));
    expect(screen.getByRole('button', { name: 'Undo attachment removal' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('button', { name: 'Undo attachment removal' })).not.toBeInTheDocument();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('keeps the attachment Undo while the pointer is on it and starts the clock again when the pointer leaves', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    const notice = screen.getByRole('button', { name: 'Undo attachment removal' }).closest('[role="status"]')!;
    fireEvent.mouseEnter(notice);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('button', { name: 'Undo attachment removal' })).toBeInTheDocument();
    fireEvent.mouseLeave(notice);
    act(() => vi.advanceTimersByTime(7_999));
    expect(screen.getByRole('button', { name: 'Undo attachment removal' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('button', { name: 'Undo attachment removal' })).not.toBeInTheDocument();
  });

  it('a replacement attachment supersedes the removed file instead of leaving an Undo that restores stale input', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await userEvent.upload(file(), new File(['{"synthetic":true}'], 'SYN-REPLACEMENT.json'));
    const form = within(screen.getByRole('form', { name: 'Report and question' }));
    expect(form.getByText('SYN-REPLACEMENT.json')).toBeVisible();
    expect(form.queryByRole('button', { name: 'Undo attachment removal' })).not.toBeInTheDocument();
  });

  it('needs the synthetic confirmation before it sends (D5)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(screen.getByText('Confirm the file is synthetic.')).toBeVisible();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('sends an attached JSON report once, with the confirmation, and shows it with its status word (CH-3)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const thread = within(await conversation());
    expect(await thread.findByText(/SYN-004-cyp2c19\.json/)).toBeVisible();
    expect(await thread.findByText('Received')).toHaveClass('text-warning');
    expect(submitReport).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(submitReport).mock.calls[0]![0];
    expect(sent).toMatchObject({ patientId: PATIENT.id, reportType: 'structured', syntheticConfirmed: true });
    expect(sent.file.name).toBe('SYN-004-cyp2c19.json');
  });

  it.each(['success', 'failure'] as const)('shows a chat upload skeleton until %s, then removes it', async (outcome) => {
    let finish!: (value: { reference: string }) => void;
    let fail!: (error: Error) => void;
    vi.mocked(submitReport).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await screen.findByRole('combobox', { name: 'Patient' });
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
    const thread = await conversation();
    expect(within(thread).getByText('Uploading your report…')).toHaveAttribute('role', 'status');
    expect(thread.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(useSyntheticChat).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === 'success') finish({ reference: REPORT_ID });
      else fail(new Error('Synthetic upload failure'));
    });
    expect(within(thread).queryByText('Uploading your report…')).not.toBeInTheDocument();
    if (outcome === 'success') expect(await within(thread).findByText('Received')).toBeVisible();
    else expect(within(thread).getByRole('alert')).toHaveTextContent('The upload was interrupted.');
  });

  it('"Check status" reloads the known report and shows its new status word (CH-3)', async () => {
    const { fetchImpl } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    await screen.findByRole('combobox', { name: 'Patient' });
    await userEvent.click(screen.getByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
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

  it('offers only the file types this build accepts in the attach picker, so a PDF is not offered and then refused (CH-6)', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    expect(file()).toHaveAttribute('accept', '.json');
  });

  it('refuses a PDF without owned-storage mode, naming the local preview, and uploads nothing (CH-6, D4)', async () => {
    const { fetchImpl } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), new File(['%PDF-1.4'], 'SYN-004.pdf', { type: 'application/pdf' }), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(/local preview/i);
    await userEvent.click(await screen.findByRole('checkbox', CONFIRM));
    await userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
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

  it('says so when the patient list fails, and Retry loads it without a reload, which would sign the tab out', async () => {
    let patientsDown = true;
    const ok = api(['clinician']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) =>
      patientsDown && String(input).includes('/api/v1/patients') ? new Response('{}', { status: 503 }) : ok(input, init),
    );
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(file(), json());
    const retry = await screen.findByRole('button', { name: 'Retry loading patients' });
    expect(within(retry.parentElement!).getByRole('alert')).toHaveTextContent(/patients/i);
    patientsDown = false;
    await userEvent.click(retry);
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    expect(screen.queryByRole('button', { name: 'Retry loading patients' })).not.toBeInTheDocument();
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
  it("a patient added on its page appears in the chat's patient choice (CH-9)", async () => {
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
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Report details' })).getByRole('link', { name: 'Add patient' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
    await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Synthetic patient label' })).toBeNull());
    await userEvent.click(await screen.findByRole('link', { name: 'Back to chat' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Report details' }));
    expect(await within(screen.getByRole('combobox', { name: 'Patient' })).findByRole('option', { name: 'SYN-777' })).toBeInTheDocument();
  });
});
