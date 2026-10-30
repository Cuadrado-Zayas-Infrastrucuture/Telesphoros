import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const REPORT = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  patientId: PATIENT.id,
  type: 'structured',
  filename: 'SYN-004-cyp2c19.json',
  sizeBytes: 120,
  status: 'processed',
  fileUploaded: true,
  contentType: 'text/plain',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
};
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });

/** The API this page reads: who I am, patients and reports. */
function api(roles: Role[], patients: unknown[] = [PATIENT]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients')
      ? page(patients)
      : url.includes('/api/v1/reports')
        ? page([REPORT])
        : url.endsWith('/api/v1/me/recovery-scope')
          ? { recoveryScope: RECOVERY_SCOPE }
          : { roles };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}

const open = (roles: Role[], patients?: unknown[]) => renderApp('/local-workspace', { signedInAs: roles, fetchImpl: api(roles, patients) as unknown as typeof fetch });
const report = () => new File(['{"synthetic":true}'], 'SYN-004-cyp2c19.json');

afterEach(() => vi.restoreAllMocks());

describe('one-screen workspace (specs/016)', () => {
  it('is its own frame: the mascot and one box, no site header, sidebar or footer', async () => {
    open(['clinician']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Telesphoros mascot in a teal cloak' })).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(document.querySelector('header.workspace-navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach a report' })).toBeVisible();
  });

  it('puts an attached file on one line with its patient, and says why Send waits for the synthetic confirmation', async () => {
    open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, report());
    expect(screen.getByText('SYN-004-cyp2c19.json')).toBeVisible();
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT.id);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status')).toHaveTextContent('Confirm the file is synthetic.');
    await userEvent.click(screen.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }));
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('refuses raw genomic data (a VCF) before anything is sent', async () => {
    const { fetchImpl } = open(['clinician']);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File(['##fileformat=VCFv4.2\n'], 'SYN-004.vcf'), { applyAccept: false });
    expect(screen.getByRole('alert')).toHaveTextContent('Raw genomic data (VCF) is not accepted.');
    await userEvent.click(screen.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/uploads'))).toBe(false);
  });

  it('offers a new synthetic patient in place when there is none, and checks the label', async () => {
    open(['clinician'], []);
    await screen.findByRole('button', { name: 'Attach a report' });
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, report());
    const label = await screen.findByRole('textbox', { name: 'New patient label' });
    await userEvent.type(label, 'Jane Doe');
    await userEvent.click(screen.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status')).toHaveTextContent(/letters, numbers and hyphens/i);
  });

  it('gives a reader no way to attach, but the sample questions still work', async () => {
    open(['reader'] as Role[]);
    await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' });
    expect(screen.queryByRole('button', { name: 'Attach a report' })).toBeNull();
    expect(within(screen.getByLabelText('Sample questions')).getAllByRole('button')).toHaveLength(3);
  });

  it('lists past reports in a panel with the status as a word in color', async () => {
    open(['clinician']);
    await userEvent.click(await screen.findByRole('button', { name: 'Past reports' }));
    const panel = await screen.findByRole('dialog', { name: 'Past reports' });
    expect(await within(panel).findByText('SYN-004-cyp2c19.json')).toBeVisible();
    expect(within(panel).getByText('Processed')).toHaveClass('text-success');
  });

  it('keeps Usage in the account menu for administrators only', async () => {
    open(['clinician']);
    await userEvent.click(await screen.findByRole('button', { name: /^Account,/ }));
    expect(screen.getByRole('link', { name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Usage' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});
