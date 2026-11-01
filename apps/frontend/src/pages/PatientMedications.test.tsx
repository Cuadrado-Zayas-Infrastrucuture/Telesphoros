import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BUNDLED_DRUG_LIST, type PatientMedicationDto, type Role } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENTRY = '1f8fad5b-d9cb-469f-a165-70867728950e';
const row: PatientMedicationDto = {
  id: ENTRY,
  entryId: ENTRY,
  patientId: ID,
  version: 1,
  current: true,
  rxcui: '5470',
  name: 'hydralazine',
  listVersion: BUNDLED_DRUG_LIST!.version,
  status: 'active',
  startMonth: '2026-01',
  stopMonth: null,
  source: 'clinician-entered',
  createdAt: '2026-11-01T12:00:00.000Z',
  createdBy: 'synthetic',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function open(roles: Role[] = ['clinician'], rows: PatientMedicationDto[] = [], mode: 'normal' | 'lost' | 'stale' = 'normal') {
  const posts: Record<string, unknown>[] = [];
  let current = rows;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), 'http://synthetic');
    if (path.pathname.endsWith('/medications')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (mode === 'stale') return json({ error: { message: 'DO-NOT-ECHO', details: [{ reason: 'medication-changed' }] } }, 409);
        if (mode === 'lost' && posts.length === 1) throw new Error('DO-NOT-ECHO');
        const next = { ...row, ...body, version: body.expectedVersion ? body.expectedVersion + 1 : 1 };
        delete next.requestId;
        delete next.expectedVersion;
        current = [next];
        return json(next, 201);
      }
      return json({ items: path.searchParams.has('version') ? [{ ...row, current: false }] : current });
    }
    if (path.pathname.endsWith('/demographics')) return json({ error: { details: [{ reason: 'no-demographics' }] } }, 404);
    if (path.pathname === `/api/v1/patients/${ID}`) return json({ id: ID, label: 'SYN-MEDICATION', createdAt: row.createdAt, updatedAt: row.createdAt, mergedInto: null });
    if (path.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (path.pathname.includes('/patients') || path.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles });
  });
  const view = renderApp(`/patients/${ID}`, { signedInAs: roles, fetchImpl });
  const region = within(await screen.findByRole('region', { name: 'Medications' }));
  await region.findByText(rows.length ? 'Start: 2026-01 · Stop: Not recorded' : 'No medications recorded yet.');
  return { region, posts, view, fetchImpl };
}

describe('patient medication capture', () => {
  it('offers local suggestions and requires an explicit keyboard choice before saving', async () => {
    const { region, posts } = await open();
    await userEvent.click(region.getByRole('button', { name: 'Add medication' }));
    const input = region.getByRole('combobox', { name: 'Drug' });
    await userEvent.type(input, 'hydralaz');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Enter}');
    expect(posts).toHaveLength(0);
    await userEvent.click(region.getByRole('button', { name: 'Save medication' }));
    expect(await region.findByRole('alert')).toHaveTextContent('Choose a drug');
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('hydrALAZINE');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(region.getByRole('button', { name: 'Save medication' }));
    await region.findByText('Medication saved.');
    expect(posts[0]).toMatchObject({ rxcui: '5470' });
  });

  it('clears a chosen code when its search text changes and does not choose on Escape', async () => {
    const { region, posts } = await open();
    await userEvent.click(region.getByRole('button', { name: 'Add medication' }));
    const input = region.getByRole('combobox', { name: 'Drug' });
    await userEvent.type(input, 'hydralaz');
    await userEvent.click(region.getByRole('option', { name: 'hydralazine' }));
    await userEvent.clear(input);
    await userEvent.type(input, 'codeine');
    await userEvent.keyboard('{Escape}');
    expect(region.queryByRole('listbox')).toBeNull();
    await userEvent.click(region.getByRole('button', { name: 'Save medication' }));
    expect(await region.findByRole('alert')).toHaveTextContent('Choose a drug');
    expect(posts).toHaveLength(0);
  });
  it('shows active first, FDA Tall Man visually, plain accessible names and recorded source/months', async () => {
    const stopped = {
      ...row,
      entryId: '2f8fad5b-d9cb-469f-a165-70867728950e',
      name: 'codeine',
      rxcui: '2670',
      status: 'stopped' as const,
      source: 'patient-reported' as const,
      stopMonth: '2026-03',
    };
    const { region } = await open(['reader'], [stopped, row]);
    const entries = region.getAllByRole('listitem');
    expect(within(entries[0]).getByRole('heading', { name: 'hydralazine' })).toHaveTextContent('hydrALAZINE');
    expect(entries[0]).toHaveTextContent('Active');
    expect(entries[0]).toHaveTextContent('Clinician-entered');
    expect(entries[1]).toHaveTextContent('Stopped');
    expect(entries[1]).toHaveTextContent('Patient-reported');
    expect(entries[1]).toHaveTextContent('Stop: 2026-03');
  });

  it.each<Role>(['reader', 'reviewer'])('offers %s no medication writes', async (role) => {
    const { region } = await open([role], [row]);
    await userEvent.click(region.getByRole('button', { name: 'Details for hydralazine' }));
    expect(region.queryByRole('button', { name: 'Add medication' })).toBeNull();
    expect(region.queryByRole('button', { name: 'Correct hydralazine' })).toBeNull();
    expect(region.queryByRole('button', { name: 'Stop hydralazine' })).toBeNull();
  });

  it('filters in lower case, selects a coded Tall Man name and retries with the same request id after a lost response', async () => {
    const { region, posts } = await open(['clinician'], [], 'lost');
    await userEvent.click(region.getByRole('button', { name: 'Add medication' }));
    await userEvent.type(region.getByRole('combobox', { name: 'Drug' }), 'hydralaz');
    expect(region.getByRole('option', { name: 'hydralazine' })).toHaveTextContent('hydrALAZINE');
    await userEvent.clear(region.getByRole('combobox', { name: 'Drug' }));
    await userEvent.type(region.getByRole('combobox', { name: 'Drug' }), 'hydralaz');
    await userEvent.click(region.getByRole('option', { name: 'hydralazine' }));
    await userEvent.selectOptions(region.getByLabelText('Source'), 'patient-reported');
    await userEvent.click(region.getByRole('button', { name: 'Save medication' }));
    expect(await region.findByRole('alert')).not.toHaveTextContent('DO-NOT-ECHO');
    await userEvent.click(region.getByRole('button', { name: 'Save medication' }));
    await region.findByText('Medication saved.');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0]).toMatchObject({ rxcui: '5470', source: 'patient-reported', status: 'active', startMonth: null, stopMonth: null });
    expect(posts[0]).not.toHaveProperty('name');
    expect(posts[0]).not.toHaveProperty('displayName');
  });

  it('stops by adding the next version with the version the clinician saw', async () => {
    const { region, posts } = await open(['clinician'], [row]);
    await userEvent.click(region.getByRole('button', { name: 'Details for hydralazine' }));
    await userEvent.click(region.getByRole('button', { name: 'Stop hydralazine' }));
    fireEvent.change(region.getByLabelText('Stop month (optional)'), { target: { value: '2026-03' } });
    await userEvent.click(region.getByRole('button', { name: 'Save stopped medication' }));
    await region.findByText('Medication saved.');
    expect(posts[0]).toMatchObject({ entryId: ENTRY, expectedVersion: 1, rxcui: '5470', status: 'stopped', startMonth: '2026-01', stopMonth: '2026-03' });
    expect(region.queryByRole('button', { name: 'Stop hydralazine' })).toBeNull();
    await userEvent.click(region.getByRole('button', { name: 'Details for hydralazine' }));
    await userEvent.click(region.getByRole('button', { name: 'Earlier versions of hydralazine' }));
    await region.findByText('Version 1 (earlier)');
  });

  it('retains a rejected stale correction without presenting it as saved', async () => {
    const { region, posts } = await open(['clinician'], [row], 'stale');
    await userEvent.click(region.getByRole('button', { name: 'Details for hydralazine' }));
    await userEvent.click(region.getByRole('button', { name: 'Correct hydralazine' }));
    await userEvent.selectOptions(region.getByLabelText('Source'), 'patient-reported');
    await userEvent.click(region.getByRole('button', { name: 'Save correction' }));
    expect(await region.findByRole('alert')).toHaveTextContent('Cancel and reload');
    expect(region.getByLabelText('Source')).toHaveValue('patient-reported');
    expect(region.queryByText('Medication saved.')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('has no accessibility violations with the medication form expanded', async () => {
    const { region, view } = await open();
    await userEvent.click(region.getByRole('button', { name: 'Add medication' }));
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('refuses free text and reversed months before making a write request', async () => {
    const { region, posts } = await open();
    await userEvent.click(region.getByRole('button', { name: 'Add medication' }));
    await userEvent.type(region.getByRole('combobox', { name: 'Drug' }), 'not-a-listed-ingredient');
    expect(region.getByText('No matching drugs. Try another name.')).toBeVisible();
    fireEvent.submit(region.getByRole('form', { name: 'Add medication' }));
    expect(await region.findByRole('alert')).toHaveTextContent('Choose a drug');
    expect(posts).toHaveLength(0);
    await userEvent.clear(region.getByRole('combobox', { name: 'Drug' }));
    await userEvent.clear(region.getByRole('combobox', { name: 'Drug' }));
    await userEvent.type(region.getByRole('combobox', { name: 'Drug' }), 'hydralaz');
    await userEvent.click(region.getByRole('option', { name: 'hydralazine' }));
    await userEvent.selectOptions(region.getByLabelText('Status'), 'stopped');
    fireEvent.change(region.getByLabelText('Start month (optional)'), { target: { value: '2026-03' } });
    fireEvent.change(region.getByLabelText('Stop month (optional)'), { target: { value: '2026-02' } });
    fireEvent.submit(region.getByRole('form', { name: 'Add medication' }));
    expect(await region.findByRole('alert')).toHaveTextContent('Stop must not precede start');
    expect(posts).toHaveLength(0);
  });

  it('hides the previous patient while the next patient is loading', async () => {
    const { view, fetchImpl } = await open(['clinician'], [row]);
    const next = '3f8fad5b-d9cb-469f-a165-70867728950e';
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation((url, init) => (String(url).includes(next) ? new Promise<Response>(() => undefined) : original(url, init)));
    await act(async () => {
      await view.router.navigate(`/patients/${next}`);
    });
    expect(screen.queryByRole('heading', { name: 'SYN-MEDICATION' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Medications' })).toBeNull();
  });
});
