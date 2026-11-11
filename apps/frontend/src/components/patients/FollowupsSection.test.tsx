import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { FOLLOWUPS_PAUSED_MESSAGE } from '@/lib/patientFollowups';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const THREAD = '3f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-01T12:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The patient page with an empty follow-up list; `availability` is what GET /followups/availability answers. */
async function open(availability: Response | 'missing', path = `/patients/${ID}`) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url), 'http://synthetic');
    if (at.pathname === '/api/v1/followups/availability') return availability === 'missing' ? json({ error: {} }, 404) : availability.clone();
    if (at.pathname === '/api/v1/followups/assignees') return json({ currentActor: 'person-1', items: ['person-1'] });
    if (at.pathname.endsWith('/followups'))
      return json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: 0, unassigned: 0 } });
    if (at.pathname.endsWith('/medications')) return json({ items: [] });
    if (at.pathname.endsWith('/demographics')) return json({ error: { details: [{ reason: 'no-demographics' }] } }, 404);
    if (at.pathname === `/api/v1/patients/${ID}`) return json({ id: ID, label: 'SYN-FOLLOWUP', createdAt: NOW, updatedAt: NOW, mergedInto: null });
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles: ['clinician'] });
  });
  renderApp(path, { signedInAs: ['clinician'], fetchImpl });
  const region = within(await screen.findByRole('region', { name: 'Follow-up' }));
  await region.findByText('No follow-ups recorded yet.');
  return { region, fetchImpl };
}

describe('follow-up section, by whether this environment records follow-ups', () => {
  it('offers both forms when recording is on', async () => {
    const { region } = await open(json({ recording: 'enabled' }));
    expect(region.getByRole('button', { name: 'Document follow-up' })).toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Schedule follow-up' })).toBeInTheDocument();
    expect(region.queryByText(FOLLOWUPS_PAUSED_MESSAGE)).not.toBeInTheDocument();
  });
  it('offers no form and says why when recording is paused', async () => {
    const { region } = await open(json({ recording: 'paused' }));
    expect(await region.findByText(FOLLOWUPS_PAUSED_MESSAGE)).toBeInTheDocument();
    expect(region.queryByRole('button', { name: 'Document follow-up' })).not.toBeInTheDocument();
    expect(region.queryByRole('button', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
    // Reading is untouched.
    expect(region.getByRole('button', { name: 'Refresh follow-ups' })).toBeInTheDocument();
  });
  it('shows the list, not an entry form, when a link asks for one while paused', async () => {
    const { region } = await open(json({ recording: 'paused' }), `/patients/${ID}?followup=${THREAD}#followups`);
    expect(await region.findByText(FOLLOWUPS_PAUSED_MESSAGE)).toBeInTheDocument();
    expect(region.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
  it('behaves as before when the API has no availability read (an older API)', async () => {
    const { region, fetchImpl } = await open('missing');
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/followups/availability'))).toBe(true);
    expect(region.getByRole('button', { name: 'Schedule follow-up' })).toBeInTheDocument();
    expect(region.queryByText(FOLLOWUPS_PAUSED_MESSAGE)).not.toBeInTheDocument();
  });
});
