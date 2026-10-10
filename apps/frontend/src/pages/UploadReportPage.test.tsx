import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UploadReportPage from '@/pages/UploadReportPage';
import { SubmitError, submitReport } from '@/lib/api';

const patientId = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-10T00:00:00.000Z';
const patient = { id: patientId, label: 'SYN-0001', createdAt: date, updatedAt: date };
const patientApi = vi.fn();
const pageResponse = (data = [patient], page = 1, total = data.length) => new Response(JSON.stringify({ data, meta: { page, pageSize: 20, total, totalPages: Math.ceil(total / 20) } }));
vi.mock('@/auth/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/AuthProvider')>()),
  useAuth: () => ({ apiFetch: patientApi }),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  submitReport: vi.fn(),
}));
const submitMock = vi.mocked(submitReport);

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
  patientApi.mockReset().mockResolvedValueOnce(pageResponse([patient], 1, 21)).mockResolvedValueOnce(pageResponse([second], 2, 21));
  const user = userEvent.setup(); render(<UploadReportPage />);
  await screen.findByRole('option', { name: 'SYN-0001' });
  await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
  await user.click(screen.getByRole('button', { name: 'Next patients' }));
  await screen.findByRole('option', { name: 'SYN-0021' });
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(patientId);
  expect(screen.getByRole('option', { name: 'SYN-0001' })).toBeInTheDocument();
  expect(patientApi.mock.calls.map(call => call[0])).toEqual(['/api/v1/patients?page=1&pageSize=20', '/api/v1/patients?page=2&pageSize=20']);
});

it('reports a list failure, preserves selection, and retries the requested page', async () => {
  patientApi.mockReset().mockResolvedValueOnce(pageResponse([patient], 1, 21)).mockRejectedValueOnce(new Error('sensitive payload')).mockResolvedValueOnce(pageResponse([patient], 2, 21));
  const user = userEvent.setup(); render(<UploadReportPage />);
  await screen.findByRole('option', { name: 'SYN-0001' });
  await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
  await user.click(screen.getByRole('button', { name: 'Next patients' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Patients could not be loaded');
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue(patientId);
  await user.click(screen.getByRole('button', { name: 'Refresh patients' }));
  await screen.findByText('Patient page 2 of 2');
  expect(patientApi.mock.calls.at(-1)?.[0]).toBe('/api/v1/patients?page=2&pageSize=20');
});

it('handles an empty patient list without creating a patient', async () => {
  patientApi.mockReset().mockResolvedValue(pageResponse([]));
  const user = userEvent.setup(); render(<UploadReportPage />);
  expect(await screen.findByText(/No patients available/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  expect(await screen.findByText('Choose an existing patient.')).toBeInTheDocument();
  expect(submitMock).not.toHaveBeenCalled(); expect(patientApi).toHaveBeenCalledTimes(1);
});

it('keeps one progress object across retries and clears it when starting another report', async () => {
  submitMock.mockReset().mockRejectedValueOnce(new SubmitError('Retry')).mockResolvedValue({ reference: 'verified-report-id' });
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup(); render(<UploadReportPage />); await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' })); await screen.findByText('Retry');
  const progress = submitMock.mock.calls[0]![2];
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  await screen.findByText(/verified-report-id/); expect(submitMock.mock.calls[1]![2]).toBe(progress);
  expect(screen.getByText('Upload complete')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Upload another report' })); await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' })); await screen.findByText(/verified-report-id/);
  expect(submitMock.mock.calls[2]![2]).not.toBe(progress);
});

it('never renders raw service or transport errors', async () => {
  submitMock.mockReset().mockRejectedValue(new Error('raw token or patient payload'));
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup(); render(<UploadReportPage />); await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The upload was interrupted.');
  expect(screen.queryByText(/raw token/)).not.toBeInTheDocument();
});


it('lets the user explicitly abandon a refused retry and start a new upload', async () => {
  submitMock.mockReset().mockRejectedValueOnce(new SubmitError('This upload conflicts with a stored report.')).mockResolvedValue({ reference: 'new-report' });
  patientApi.mockReset().mockImplementation(async () => pageResponse());
  const user = userEvent.setup(); render(<UploadReportPage />); await fillValidForm(user);
  await user.click(screen.getByRole('button', { name: 'Upload report' })); await screen.findByText(/conflicts with a stored report/);
  const old = submitMock.mock.calls[0]![2];
  await user.click(screen.getByRole('button', { name: 'Start a new upload' }));
  expect(screen.getByLabelText(/synthetic patient \(required\)/i)).toHaveValue('');
  expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files).toHaveLength(0);
  await fillValidForm(user); await user.click(screen.getByRole('button', { name: 'Upload report' })); await screen.findByText(/new-report/);
  expect(submitMock.mock.calls[1]![2]).not.toBe(old);
});
