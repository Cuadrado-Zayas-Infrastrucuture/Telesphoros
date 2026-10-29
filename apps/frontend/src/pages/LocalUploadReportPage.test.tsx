import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UploadReportPage from '@/pages/LocalUploadReportPage';
import { SubmitError, submitReport } from '@/lib/localReportApi';

vi.mock('@/lib/localReportApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localReportApi')>()),
  submitReport: vi.fn(),
}));
const submitMock = vi.mocked(submitReport);
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));

async function fillValidForm(user: ReturnType<typeof userEvent.setup>, fileName = 'sample.json') {
  await user.type(screen.getByLabelText(/synthetic patient label/i), 'SYN-0001');
  await user.selectOptions(screen.getByLabelText(/report type/i), 'structured');
  await user.upload(screen.getByLabelText(/report file/i), new File(['{"synthetic":true}'], fileName));
  await user.click(screen.getByLabelText(/synthetic data only/i));
}

describe('UploadReportPage', () => {
  // Braces matter: returning the mock from a hook makes Vitest call it as a teardown callback.
  beforeEach(() => {
    submitMock.mockReset();
  });

  it('shows a field-level error for every empty field and does not submit', async () => {
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    expect(await screen.findByText('Enter a synthetic patient label.')).toBeInTheDocument();
    expect(screen.getByText('Choose a report type.')).toBeInTheDocument();
    expect(screen.getByText('Choose a report file.')).toBeInTheDocument();
    expect(screen.getByText('Confirm that this file contains synthetic data only.')).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('links each error to its field and moves focus to the first invalid one', async () => {
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    const label = screen.getByLabelText(/synthetic patient label/i);
    await waitFor(() => expect(label).toHaveFocus());
    expect(label).toHaveAttribute('aria-invalid', 'true');
    expect(label).toHaveAccessibleDescription(/Enter a synthetic patient label\./);
  });

  it('keeps everything the user entered after a failed submit', async () => {
    // Reject lazily (when called): an eagerly-created rejected promise is flagged as unhandled.
    submitMock.mockImplementation(async () => {
      throw new SubmitError('The server could not accept this report.');
    });
    const user = userEvent.setup();
    render(<UploadReportPage />);
    await fillValidForm(user, 'fail.json');
    await user.click(screen.getByRole('button', { name: 'Upload report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not accept this report.');
    expect(screen.getByLabelText(/synthetic patient label/i)).toHaveValue('SYN-0001');
    expect(screen.getByLabelText(/report type/i)).toHaveValue('structured');
    expect(screen.getByLabelText(/synthetic data only/i)).toBeChecked();
    expect((screen.getByLabelText(/report file/i) as HTMLInputElement).files?.[0]?.name).toBe('fail.json');
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

    await user.click(screen.getByRole('button', { name: 'Upload report' }));
    await screen.findByText('Choose a report file.');
    expect(await axe(container)).toHaveNoViolations();
  });
});
