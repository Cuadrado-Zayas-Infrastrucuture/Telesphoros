import { render, screen, within } from '@testing-library/react';
import type { PatientDemographicsDto, PatientDto } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { PatientPicker } from '@/components/PatientPicker';
import { exactAge } from '@/lib/patientSummary';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { PatientBanner } from './PatientBanner';

const NOW = '2026-10-28T12:00:00.000Z';
const A: PatientDto = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  label: 'SYN-004',
  createdAt: NOW,
  updatedAt: NOW,
  mergedInto: null,
  sex: 'female',
  birthYear: 1970,
  ageYears: 56,
  ethnicity: null,
  demographicsComplete: false,
};
const B: PatientDto = { ...A, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-777', sex: null, birthYear: null, ageYears: null };
const VALUE: PatientDemographicsDto = {
  patientId: A.id,
  version: 1,
  current: true,
  givenName: 'Zzyzx-Synthetic',
  familyName: 'Núñez-Testcase',
  dateOfBirth: '1980-02-29',
  sex: 'female',
  birthYear: 1980,
  ageYears: 46,
  ethnicity: null,
  createdAt: NOW,
  createdBy: 'person-1',
  versions: [],
};

describe('PatientBanner', () => {
  it('shows name, date of birth, exact age and sex', () => {
    render(<PatientBanner value={VALUE} />);
    const banner = within(screen.getByRole('group', { name: 'Patient identity' }));
    expect(banner.getByText('Zzyzx-Synthetic Núñez-Testcase')).toBeInTheDocument();
    expect(banner.getByText(`Born 1980-02-29 · ${exactAge('1980-02-29')} years · Female`)).toBeInTheDocument();
  });
  it('leaves out what is not recorded', () => {
    render(<PatientBanner value={{ ...VALUE, sex: null }} />);
    expect(screen.getByText(`Born 1980-02-29 · ${exactAge('1980-02-29')} years`)).toBeInTheDocument();
  });
});

describe('PatientPicker', () => {
  it("confirms the chosen patient's coded details under the select and keeps the option text as the code", () => {
    render(<PatientPicker aria-label="Patient" patients={[A, B]} value={A.id} onValueChange={() => {}} />);
    expect(screen.getByText('SYN-004 · Female · born 1970')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SYN-004' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveAccessibleDescription('SYN-004 · Female · born 1970');
  });
  it('adds nothing when no patient is chosen or nothing is recorded for the chosen one', () => {
    const { rerender } = render(<PatientPicker aria-label="Patient" patients={[A, B]} value="" onValueChange={() => {}} />);
    expect(screen.queryByText(/born/)).not.toBeInTheDocument();
    rerender(<PatientPicker aria-label="Patient" patients={[A, B]} value={B.id} onValueChange={() => {}} />);
    expect(screen.queryByText(/SYN-777 ·/)).not.toBeInTheDocument();
  });
});

describe('Patients list', () => {
  it('shows sex and birth year beside a code, outside the link, and nothing for an unrecorded patient', async () => {
    const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: 1 } });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const body = url.includes('/api/v1/patients')
        ? page([A, B])
        : url.includes('/api/v1/reports')
          ? page([])
          : url.endsWith('/api/v1/me/recovery-scope')
            ? { recoveryScope: RECOVERY_SCOPE }
            : { roles: ['clinician'] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });
    renderApp('/patients', { signedInAs: ['clinician'], fetchImpl });
    const roster = within(await screen.findByRole('region', { name: 'Patient records' }));
    const link = await roster.findByRole('link', { name: 'SYN-004' });
    expect(within(link.closest('li')!).getByText('Female · born 1970')).toBeInTheDocument();
    const other = roster.getByRole('link', { name: 'SYN-777' });
    expect(within(other.closest('li')!).queryByText(/born/)).not.toBeInTheDocument();
  });
});

describe('Patient page', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const open = (demographics: Response) => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const at = new URL(String(input), 'http://synthetic');
      if (at.pathname.endsWith('/demographics')) return demographics.clone();
      if (at.pathname.endsWith('/medications')) return json({ items: [] });
      if (at.pathname === `/api/v1/patients/${A.id}`) return json({ id: A.id, label: A.label, createdAt: NOW, updatedAt: NOW, mergedInto: null });
      if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
      if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
      return json({ roles: ['reader'] });
    });
    renderApp(`/patients/${A.id}`, { signedInAs: ['reader'], fetchImpl });
  };
  it('puts the identity banner under the code when demographics are recorded, and keeps the code as the heading', async () => {
    open(json(VALUE));
    const banner = within(await screen.findByRole('group', { name: 'Patient identity' }));
    expect(banner.getByText('Zzyzx-Synthetic Núñez-Testcase')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'SYN-004' })).toBeInTheDocument();
    expect(document.title).not.toContain('Zzyzx');
  });
  it('shows no banner when no demographics are recorded', async () => {
    open(json({ error: { details: [{ reason: 'no-demographics' }] } }, 404));
    await screen.findByRole('heading', { level: 1, name: 'SYN-004' });
    expect(screen.queryByRole('group', { name: 'Patient identity' })).not.toBeInTheDocument();
  });
});
