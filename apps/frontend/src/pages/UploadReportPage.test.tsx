import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UploadReportPage from '@/pages/UploadReportPage';
import { SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { cancelOwnedUpload } from '@/lib/ownedStorageApi';
import { bindRecovery, endRecoverySession, readRecovery, rememberUpload, startRecoverySession, type RecoverySession } from '@/lib/uploadRecovery';

const patientId = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-10T00:00:00.000Z';
const patient = { id: patientId, label: 'SYN-0001', createdAt: date, updatedAt: date };
const patientApi = vi.fn();
let pageOwner: RecoverySession;
const pageResponse = (data = [patient], page = 1, total = data.length) =>
  new Response(JSON.stringify({ data, meta: { page, pageSize: 20, total, totalPages: Math.ceil(total / 20) } }));
vi.mock('@/auth/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/AuthProvider')>()),
  useAuth: () => ({ apiFetch: patientApi, recoverySession: pageOwner }),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  submitReport: vi.fn(),
}));
vi.mock('@/lib/ownedStorageApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ownedStorageApi')>()),
  cancelOwnedUpload: vi.fn(),
}));
const cancelMock = vi.mocked(cancelOwnedUpload);
const reportId = '22222222-2222-4222-8222-222222222222';
const interruptedUpload = () => {
  const progress: UploadProgress = {
    requestId: '55555555-5555-4555-8555-555555555555',
    reportId,
    facts: { reportType: 'vcf', name: 'half.vcf', sizeBytes: 2048, sha256: 'a'.repeat(64) },
    declaration: { requestId: '66666666-6666-4666-8666-666666666666', revision: '33333333-3333-4333-8333-333333333333', contentType: 'text/x-vcf', sha256: 'a'.repeat(64) },
    attempt: { attemptId: '44444444-4444-4444-8444-444444444444', revision: '77777777-7777-4777-8777-777777777777', state: 'declared', expiresAt: '2099-01-01T00:00:00.000Z' },
  };
  bindRecovery(progress, pageOwner);
  rememberUpload(progress);
};
const submitMock = vi.mocked(submitReport);
beforeEach(() => {
  endRecoverySession(pageOwner ?? null);
  window.sessionStorage.clear();
  pageOwner = startRecoverySession('a'.repeat(64));
});
afterEach(() => {
  endRecoverySession(pageOwner);
  vi.useRealTimers();
  window.sessionStorage.clear();
});

async function fillValidForm(user: ReturnType<typeof userEvent.setup>, fileName = 'sample.vcf') {
  await screen.findByRole('option', { name: 'SYN-0001' });
  await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
  await user.selectOptions(screen.getByLabelText(/report type/i), 'vcf');
  await user.upload(screen.getByLabelText(/report file/i), new File(['x'], fileName));
  await user.click(screen.getByLabelText(/synthetic data only/i));
}

describe('UploadReportPage', () => {
  // Braces matter: returning the mock from a hook makes Vitest call it as a teardown callback.
  beforeEach(() => {
    cancelMock.mockReset();
    submitMock.mockReset();
    patientApi.mockReset().mockImplementation(async () => pageResponse());
  });

  it('shows a field-level error for every empty field and does not submit', async () => {
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByRole('option', { name: 'SYN-0001' });
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    expect(await screen.findByText('Choose an existing patient.')).toBeInTheDocument();
    expect(screen.getByText('Choose a report type.')).toBeInTheDocument();
    expect(screen.getByText('Choose a report file.')).toBeInTheDocument();
    expect(screen.getByText('Confirm that this file contains synthetic data only.')).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('links each error to its field and moves focus to the first invalid one', async () => {
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByRole('option', { name: 'SYN-0001' });
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    const label = screen.getByLabelText(/synthetic patient \(required\)/i);
    await waitFor(() => expect(label).toHaveFocus());
    expect(label).toHaveAttribute('aria-invalid', 'true');
    expect(label).toHaveAccessibleDescription(/Choose an existing patient\./);
  });

  it('keeps everything the user entered after a failed submit', async () => {
    // Reject lazily (when called): an eagerly-created rejected promise is flagged as unhandled.
    submitMock.mockImplementation(async () => {
      throw new SubmitError('The server could not accept this report.');
    });
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await fillValidForm(user, 'fail.vcf');
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not accept this report.');
    expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(patientId);
    expect(screen.getByLabelText(/report type/i)).toHaveValue('vcf');
    expect(screen.getByLabelText(/synthetic data only/i)).toBeChecked();
    expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files?.[0]?.name).toBe('fail.vcf');
    expect(screen.getByRole('button', { name: 'Upload report' })).toBeEnabled();
  });

  it('disables submit and shows a loading state while the request is in flight', async () => {
    let finish!: (value: { reference: string }) => void;
    submitMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    const busy = await screen.findByRole('button', { name: /uploading/i });
    expect(busy).toBeDisabled();
    expect(submitMock).toHaveBeenCalledTimes(1);

    finish({ reference: 'SYN-TEST1234' });
    expect(await screen.findByText(/SYN-TEST1234/)).toBeInTheDocument();
  });

  it('offers to finish or cancel an upload that a reload interrupted, showing its size but not its name, and says nothing when there is none', async () => {
    const { unmount } = render(<UploadReportPage />);
    await screen.findByRole('option', { name: 'SYN-0001' });
    expect(screen.queryByText('An upload was interrupted')).not.toBeInTheDocument();
    unmount();
    interruptedUpload();
    render(<UploadReportPage />);
    expect(await screen.findByText('An upload was interrupted')).toBeInTheDocument();
    expect(screen.getByText('The file you chose earlier')).toBeInTheDocument();
    expect(screen.queryByText('half.vcf')).not.toBeInTheDocument();
    expect(screen.getByText(/2\.0 KiB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel the interrupted upload' })).toBeEnabled();
  });

  it('cancels the interrupted upload through the server, and only then lets go of it', async () => {
    interruptedUpload();
    cancelMock.mockRejectedValueOnce(new SubmitError('Cancellation is pending. Retry cancellation before starting over.'));
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await user.click(await screen.findByRole('button', { name: 'Cancel the interrupted upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is pending');
    expect(readRecovery(pageOwner)).toBeDefined();
    expect(cancelMock.mock.calls[0]![1]).toMatchObject({ reportId, restored: true, attempt: { state: 'declared' } });
    cancelMock.mockImplementationOnce(async () => {
      window.sessionStorage.clear();
    });
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByText('Upload cancelled. Start a new upload when ready.')).toBeInTheDocument();
  });

  it('removes the banner once the interrupted upload is cancelled and starts the next one from nothing', async () => {
    interruptedUpload();
    cancelMock.mockImplementationOnce(async () => {
      window.sessionStorage.clear();
    });
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await user.click(await screen.findByRole('button', { name: 'Cancel the interrupted upload' }));
    expect(await screen.findByText('The interrupted upload was cancelled. You can start a new one.')).toBeInTheDocument();
    expect(screen.queryByText('An upload was interrupted')).not.toBeInTheDocument();
    submitMock.mockResolvedValueOnce({ reference: reportId });
    await fillValidForm(user, 'next.vcf');
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(submitMock.mock.calls[0]![2]).toEqual({}); // a clean progress: nothing of the cancelled upload is carried over
  });

  it('has no detectable accessibility violations while offering an interrupted upload', async () => {
    interruptedUpload();
    const { container } = render(<UploadReportPage />);
    await screen.findByText('An upload was interrupted');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('hands the restored upload to the submit, so the same file continues it', async () => {
    interruptedUpload();
    submitMock.mockResolvedValueOnce({ reference: reportId });
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await fillValidForm(user, 'half.vcf');
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(submitMock.mock.calls[0]![2]).toMatchObject({ reportId, restored: true, requestId: '55555555-5555-4555-8555-555555555555' });
  });

  it('has no detectable accessibility violations (empty and error states)', async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadReportPage />);
    expect(await axe(container)).toHaveNoViolations();

    await screen.findByRole('option', { name: 'SYN-0001' });
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    await screen.findByText('Choose a report file.');
    expect(await axe(container)).toHaveNoViolations();
  });
});

it('paginates existing patients without losing the selected patient or creating records', async () => {
  const second = { ...patient, id: '22222222-2222-4222-8222-222222222222', label: 'SYN-0021' };
  patientApi
    .mockReset()
    .mockResolvedValueOnce(pageResponse([patient], 1, 21))
    .mockResolvedValueOnce(pageResponse([second], 2, 21));
  const user = userEvent.setup();
  render(<UploadReportPage />);
  await screen.findByRole('option', { name: 'SYN-0001' });
  await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
  await user.click(screen.getByRole('button', { name: 'Next patients' }));
  await screen.findByRole('option', { name: 'SYN-0021' });
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(patientId);
  expect(screen.getByRole('option', { name: 'SYN-0001' })).toBeInTheDocument();
  expect(patientApi.mock.calls.map((call) => call[0])).toEqual(['/api/v1/patients?page=1&pageSize=20', '/api/v1/patients?page=2&pageSize=20']);
});

it('reports a list failure, preserves selection, and retries the requested page', async () => {
  patientApi
    .mockReset()
    .mockResolvedValueOnce(pageResponse([patient], 1, 21))
    .mockRejectedValueOnce(new Error('sensitive payload'))
    .mockResolvedValueOnce(pageResponse([patient], 2, 21));
  const user = userEvent.setup();
  render(<UploadReportPage />);
  await screen.findByRole('option', { name: 'SYN-0001' });
  await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
  await user.click(screen.getByRole('button', { name: 'Next patients' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Patients could not be loaded');
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(patientId);
  await user.click(screen.getByRole('button', { name: 'Refresh patients' }));
  await screen.findByText('Patient page 2 of 2');
  expect(patientApi.mock.calls.at(-1)?.[0]).toBe('/api/v1/patients?page=2&pageSize=20');
});

it('handles an empty patient list without creating a patient on its own', async () => {
  patientApi.mockReset().mockResolvedValue(pageResponse([]));
  const user = userEvent.setup();
  render(<UploadReportPage />);
  expect(await screen.findByText('No patients yet. Add a synthetic patient to continue.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  expect(await screen.findByText('Choose an existing patient.')).toBeInTheDocument();
  expect(submitMock).not.toHaveBeenCalled();
  // One list request and nothing else: a patient is only ever added by an explicit click on "Add patient".
  expect(patientApi).toHaveBeenCalledTimes(1);
});

const createdPatient = { id: '77777777-7777-4777-8777-777777777777', label: 'SYN-0002', createdAt: date, updatedAt: date };
const postedBodies = () => patientApi.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body as string));
/** The roster is empty until a POST succeeds; after that the list holds the new patient. `post` answers each POST. */
function rosterThatGrows(post: () => Response | Promise<Response>) {
  let added = false;
  patientApi.mockReset().mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const answer = await post();
      if (answer.ok) added = true;
      return answer;
    }
    return pageResponse(added ? [createdPatient] : []);
  });
}
const createdAnswer = () => new Response(JSON.stringify(createdPatient), { status: 201 });

describe('adding a synthetic patient', () => {
  it('offers the form by itself when the roster is empty, then selects the new patient', async () => {
    rosterThatGrows(createdAnswer);
    const user = userEvent.setup();
    render(<UploadReportPage />);
    expect(await screen.findByText('No patients yet. Add a synthetic patient to continue.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Add a synthetic patient' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Synthetic patient label'), 'SYN-0002');
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    expect(await screen.findByText('Added SYN-0002 and selected it.')).toBeInTheDocument();
    expect(postedBodies()).toEqual([{ label: 'SYN-0002', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    await waitFor(() => expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(createdPatient.id));
    // Keyboard users carry on from the patient list once it has reloaded.
    await waitFor(() => expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveFocus());
    expect(screen.getByRole('option', { name: 'SYN-0002' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Add a synthetic patient' })).not.toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('adds the patient when Enter is pressed in the label field, and does not submit the upload', async () => {
    rosterThatGrows(createdAnswer);
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByText('No patients yet. Add a synthetic patient to continue.');
    const field = screen.getByLabelText('Synthetic patient label');
    // The property under test: Enter must not fire the upload form's own submit.
    const uploadFormSubmitted = vi.fn();
    field.closest('form')!.addEventListener('submit', uploadFormSubmitted);
    await user.type(field, 'SYN-0002{Enter}');
    expect(await screen.findByText('Added SYN-0002 and selected it.')).toBeInTheDocument();
    expect(postedBodies()).toHaveLength(1);
    expect(uploadFormSubmitted).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it.each([
    ['Jane Doe', /letters, numbers and hyphens only/i],
    ['', 'Enter a synthetic patient label.'],
  ])('refuses the label %j before asking the server', async (label, message) => {
    rosterThatGrows(createdAnswer);
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByText('No patients yet. Add a synthetic patient to continue.');
    const field = screen.getByLabelText('Synthetic patient label');
    if (label) await user.type(field, label);
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue(label);
    expect(postedBodies()).toHaveLength(0);
  });

  it.each([
    [409, 'A patient with that label already exists. Choose it from the list, or use a different label.'],
    [403, 'Your role cannot add patients.'],
  ])('answers %i in plain words, keeps what was typed and selects nobody', async (status, message) => {
    rosterThatGrows(() => new Response(JSON.stringify({ message: 'internal detail' }), { status }));
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByText('No patients yet. Add a synthetic patient to continue.');
    await user.type(screen.getByLabelText('Synthetic patient label'), 'SYN-0001');
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText(/internal detail/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Synthetic patient label')).toHaveValue('SYN-0001');
    expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add patient' })).toBeEnabled();
  });

  it('retries a lost request with the same request id, and uses a new one for a different label', async () => {
    let attempt = 0;
    rosterThatGrows(() => {
      attempt += 1;
      if (attempt < 3) throw new TypeError('offline');
      return createdAnswer();
    });
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await screen.findByText('No patients yet. Add a synthetic patient to continue.');
    const field = screen.getByLabelText('Synthetic patient label');
    await user.type(field, 'SYN-0002');
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The patient could not be added. Check your connection, then retry.');
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    await waitFor(() => expect(postedBodies()).toHaveLength(2));
    await user.clear(field);
    await user.type(field, 'SYN-0003');
    await user.click(screen.getByRole('button', { name: 'Add patient' }));
    await waitFor(() => expect(postedBodies()).toHaveLength(3));
    const [first, second, third] = postedBodies();
    expect(second.requestId).toBe(first.requestId);
    expect(third.requestId).not.toBe(first.requestId);
    expect(third.label).toBe('SYN-0003');
  });

  it('stays one click away when patients already exist, and can be cancelled', async () => {
    patientApi.mockReset().mockImplementation(async () => pageResponse());
    const user = userEvent.setup();
    const { container } = render(<UploadReportPage />);
    await screen.findByRole('option', { name: 'SYN-0001' });
    expect(screen.queryByRole('group', { name: 'Add a synthetic patient' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a synthetic patient' }));
    expect(screen.getByRole('group', { name: 'Add a synthetic patient' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Add a synthetic patient' })).not.toBeInTheDocument();
    expect(postedBodies()).toHaveLength(0);
  });
});

it('keeps one progress object across retries and clears it when starting another report', async () => {
  submitMock.mockReset().mockRejectedValueOnce(new SubmitError('Retry')).mockResolvedValue({ reference: 'verified-report-id' });
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup();
  render(<UploadReportPage />);
  await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText('Retry');
  const progress = submitMock.mock.calls[0]![2];
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText(/verified-report-id/);
  expect(submitMock.mock.calls[1]![2]).toBe(progress);
  expect(screen.getByText('Upload complete')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Upload another report' }));
  await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText(/verified-report-id/);
  expect(submitMock.mock.calls[2]![2]).not.toBe(progress);
});

it('never renders raw service or transport errors', async () => {
  submitMock.mockReset().mockRejectedValue(new Error('raw token or patient payload'));
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup();
  render(<UploadReportPage />);
  await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The upload was interrupted.');
  expect(screen.queryByText(/raw token/)).not.toBeInTheDocument();
});

it('lets the user explicitly abandon a refused retry and start a new upload', async () => {
  submitMock.mockReset().mockRejectedValueOnce(new SubmitError('This upload conflicts with a stored report.')).mockResolvedValue({ reference: 'new-report' });
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup();
  render(<UploadReportPage />);
  await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText(/conflicts with a stored report/);
  const old = submitMock.mock.calls[0]![2];
  await user.click(screen.getByRole('button', { name: 'Start a new upload' }));
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue('');
  expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files).toHaveLength(0);
  await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText(/new-report/);
  expect(submitMock.mock.calls[1]![2]).not.toBe(old);
});

describe('guided upload questionnaire', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    submitMock.mockReset();
    cancelMock.mockReset();
    patientApi.mockReset().mockImplementation(async () => pageResponse());
  });
  it('validates each step, preserves the file across navigation and mode changes, and submits only after confirmation', async () => {
    submitMock.mockResolvedValue({ reference: 'SYN-GUIDED' });
    const user = userEvent.setup();
    const { container } = render(<UploadReportPage />);
    await screen.findByRole('option', { name: 'SYN-0001' });
    await user.click(screen.getByRole('button', { name: 'Guide me step by step' }));
    expect(screen.getByRole('progressbar', { name: 'Upload guide progress' })).toHaveAttribute('value', '1');
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(await screen.findByText('Choose an existing patient.')).toBeVisible();
    expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveFocus();
    await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    await screen.findByRole('heading', { name: 'Choose file' });
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(await screen.findByText('Choose a report type.')).toBeVisible();
    await user.selectOptions(screen.getByLabelText(/report type/i), 'vcf');
    await user.upload(screen.getByLabelText(/report file/i), new File(['x'], 'guided.vcf'));
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    const review = await screen.findByRole('heading', { name: 'Review upload' });
    expect(review).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Upload summary' })).toHaveTextContent('guided.vcf');
    expect(submitMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Previous step' }));
    expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files?.[0]?.name).toBe('guided.vcf');
    await user.click(screen.getByRole('button', { name: 'Show full form' }));
    expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files?.[0]?.name).toBe('guided.vcf');
    await user.click(screen.getByRole('button', { name: 'Guide me step by step' }));
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    await screen.findByRole('heading', { name: 'Choose file' });
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    await screen.findByRole('heading', { name: 'Review upload' });
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(await screen.findByText('Confirm that this file contains synthetic data only.')).toBeVisible();
    expect(submitMock).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByLabelText(/synthetic data only/i));
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    expect(await screen.findByRole('heading', { name: 'Report received' })).toBeVisible();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});

it('removes an idle recovery banner at the fixed one-hour boundary', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-14T12:00:00Z');
  interruptedUpload();
  await act(async () => {
    render(<UploadReportPage />);
  });
  expect(screen.getByText('The file you chose earlier')).toBeVisible();
  await act(async () => {
    vi.advanceTimersByTime(3600000);
  });
  expect(screen.queryByText('The file you chose earlier')).not.toBeInTheDocument();
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBeNull();
});
