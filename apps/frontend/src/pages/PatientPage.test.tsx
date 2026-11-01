import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PATIENT = { id: ID, label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const NAME = 'Zzyzx-Needle';
const v1 = { version: 1, createdAt: '2026-10-30T12:00:00.000Z', createdBy: 'person-1', sex: null, birthYear: 1980, ethnicity: null };
const v2 = { version: 2, createdAt: '2026-10-31T12:00:00.000Z', createdBy: 'person-1', sex: 'female', birthYear: 1980, ethnicity: ['asian', 'white'] };
const CURRENT = { patientId: ID, current: true, givenName: NAME, familyName: 'Núñez-Testcase', dateOfBirth: '1980-02-29', ageYears: 46, ...v2, versions: [v1, v2] };
const EARLIER = { ...CURRENT, ...v1, current: false, familyName: 'Earlier-Testcase' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, reason: string) => json(status, { error: { code: 'X', message: 'm', details: [{ field: 'request', message: 'm', reason }] } });

type Demographics = 'found' | 'none' | 'erased';
function api(roles: Role[], demographics: Demographics = 'found') {
  const posts: Record<string, unknown>[] = [];
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://x');
    if (url.pathname === `/api/v1/patients/${ID}/demographics`) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json(201, { ...CURRENT, version: 3, versions: [v1, v2, { ...v2, version: 3 }] });
      }
      if (demographics === 'none') return refusal(404, 'no-demographics');
      if (demographics === 'erased') return refusal(410, 'identity-erased');
      return json(200, url.searchParams.get('version') === '1' ? EARLIER : CURRENT);
    }
    if (url.pathname === `/api/v1/patients/${ID}`) return json(200, PATIENT);
    if (url.pathname.endsWith('/api/v1/me/recovery-scope')) return json(200, { recoveryScope: RECOVERY_SCOPE });
    if (url.pathname.includes('/api/v1/patients') || url.pathname.includes('/api/v1/reports'))
      return json(200, { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json(200, { roles });
  });
  return { impl, posts };
}
async function openPage(roles: Role[], demographics: Demographics = 'found') {
  const { impl, posts } = api(roles, demographics);
  const view = renderApp(`/patients/${ID}`, { signedInAs: roles, fetchImpl: impl as unknown as typeof fetch });
  await screen.findByRole('heading', { level: 1, name: 'SYN-004' });
  return { impl, posts, view };
}

afterEach(() => vi.restoreAllMocks());

describe('the patient page (spec 025 T303, PD-5)', () => {
  it('shows a reader the current demographics and every version, with no correction control', async () => {
    await openPage(['reader']);
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    expect(await section.findByText(NAME)).toBeVisible();
    expect(section.getByText('Female')).toBeVisible();
    expect(section.getByText('Asian, White')).toBeVisible();
    expect(section.getByText('Complete')).toHaveClass('text-success');
    const versions = section.getAllByRole('listitem').map((item) => item.textContent);
    expect(versions[0]).toMatch(/^Version 2 \(current\)/);
    expect(versions[1]).toMatch(/^Version 1/);
    expect(section.queryByRole('button', { name: 'Correct' })).toBeNull();
  });

  it('never puts a name or a date of birth in the page title or the address', async () => {
    await openPage(['reader']);
    await screen.findByText(NAME);
    expect(document.title).toContain('SYN-004');
    for (const value of [NAME, 'Núñez', '1980-02-29']) {
      expect(document.title).not.toContain(value);
      expect(window.location.href).not.toContain(value);
    }
  });

  it('opens an earlier version by its number, marked as earlier, and goes back to the current one', async () => {
    const { impl } = await openPage(['reader']);
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    await section.findByText(NAME);
    await userEvent.click(section.getByRole('button', { name: 'View' }));
    expect(await section.findByText('Earlier-Testcase')).toBeVisible();
    expect(section.getByRole('status')).toHaveTextContent('Showing version 1, an earlier version.');
    expect(section.getByText('Incomplete')).toHaveClass('text-warning');
    expect(impl.mock.calls.some(([input]) => String(input).endsWith(`/demographics?version=1`))).toBe(true);
    await userEvent.click(section.getByRole('button', { name: 'Show the current version' }));
    expect(await section.findByText('Núñez-Testcase')).toBeVisible();
  });

  it('lets a clinician correct: the form starts from the current values, and saving adds a version with a request id', async () => {
    const { posts } = await openPage(['clinician']);
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    await section.findByText(NAME);
    await userEvent.click(section.getByRole('button', { name: 'Correct' }));
    const form = within(section.getByRole('form', { name: 'Correct demographics' }));
    expect(form.getByRole('textbox', { name: 'Given name' })).toHaveValue(NAME);
    expect(form.getByRole('checkbox', { name: 'White' })).toBeChecked();
    const family = form.getByRole('textbox', { name: 'Family name' });
    await userEvent.clear(family);
    await userEvent.type(family, 'Corrected-Testcase');
    await userEvent.click(form.getByRole('button', { name: 'Save correction' }));
    expect(await section.findByRole('button', { name: 'Correct' })).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ givenName: NAME, familyName: 'Corrected-Testcase', dateOfBirth: '1980-02-29', sex: 'female', ethnicity: ['asian', 'white'] });
    expect(posts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an incomplete correction before any request', async () => {
    const { posts } = await openPage(['clinician']);
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    await section.findByText(NAME);
    await userEvent.click(section.getByRole('button', { name: 'Correct' }));
    const form = within(section.getByRole('form', { name: 'Correct demographics' }));
    fireEvent.change(form.getByLabelText('Date of birth'), { target: { value: '' } });
    await userEvent.click(form.getByRole('button', { name: 'Save correction' }));
    expect(await form.findByText('Enter the date of birth.')).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  it('with no demographics yet, says so, shows Incomplete, and offers a clinician the first version', async () => {
    await openPage(['clinician'], 'none');
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    expect(await section.findByText('No demographics recorded yet.')).toBeVisible();
    expect(section.getByText('Incomplete')).toHaveClass('text-warning');
    await userEvent.click(section.getByRole('button', { name: 'Record demographics' }));
    expect(section.getByRole('form', { name: 'Record demographics' })).toBeVisible();
  });

  it('after erasure, says the identity was erased and offers nothing to write', async () => {
    await openPage(['clinician'], 'erased');
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    expect(await section.findByText(/identity was erased/)).toBeVisible();
    expect(section.queryByRole('button')).toBeNull();
  });

  it('has no accessibility violations, with the correction form open', async () => {
    const { view } = await openPage(['clinician']);
    const section = within(await screen.findByRole('region', { name: 'Demographics' }));
    await section.findByText(NAME);
    await userEvent.click(section.getByRole('button', { name: 'Correct' }));
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
