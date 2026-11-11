import { screen, within } from '@testing-library/react';
import type { FollowupDto } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ME = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE = '88888888-8888-4888-8888-88888888ab9f';
const NOW = '2026-11-01T12:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const entry = (id: string, assignee: string, createdBy: string): FollowupDto => ({
  id,
  threadId: id,
  patientId: ID,
  patientLabel: 'SYN-PEOPLE',
  medicationId: '1f8fad5b-d9cb-469f-a165-70867728950e',
  medicationName: 'hydralazine',
  decisionId: null,
  version: 1,
  action: 'schedule',
  assessment: null,
  note: 'Synthetic treatment follow-up',
  noteRedacted: false,
  next: { date: '2026-12-01', timezone: 'America/Puerto_Rico', assignee },
  createdAt: NOW,
  createdBy,
  current: true,
  dueState: 'upcoming',
  needsReassignment: false,
});

describe('who a follow-up names', () => {
  it('shows the signed-in clinician as Me and a colleague as a short label, never a raw id', async () => {
    const items = [entry('2f8fad5b-d9cb-469f-a165-70867728950e', COLLEAGUE, ME), entry('3f8fad5b-d9cb-469f-a165-70867728950e', ME, COLLEAGUE)];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const at = new URL(String(url), 'http://synthetic');
      if (at.pathname === '/api/v1/followups/assignees') return json({ currentActor: ME, items: [ME, COLLEAGUE] });
      if (at.pathname.endsWith('/followups')) return json({ currentActor: ME, items, page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: 2, unassigned: 0 } });
      if (at.pathname.endsWith('/medications')) return json({ items: [] });
      if (at.pathname.endsWith('/demographics')) return json({ error: { details: [{ reason: 'no-demographics' }] } }, 404);
      if (at.pathname === `/api/v1/patients/${ID}`) return json({ id: ID, label: 'SYN-PEOPLE', createdAt: NOW, updatedAt: NOW, mergedInto: null });
      if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
      if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
      return json({ roles: ['clinician'] });
    });
    renderApp(`/patients/${ID}`, { signedInAs: ['clinician'], fetchImpl });
    const region = within(await screen.findByRole('region', { name: 'Follow-up' }));
    expect(await region.findByText('Responsible clinician: Clinician AB9F')).toBeInTheDocument();
    expect(region.getByText('Responsible clinician: Me')).toBeInTheDocument();
    expect(region.getByText(/Recorded .* · Me$/)).toBeInTheDocument();
    expect(region.getByText(/Recorded .* · Clinician AB9F$/)).toBeInTheDocument();
    expect(region.queryByText(new RegExp(COLLEAGUE))).not.toBeInTheDocument();
    expect(region.queryByText(new RegExp(ME))).not.toBeInTheDocument();
  });
});
