import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { followupClosureNoticesSchema } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Spec 045 FN-5: the Follow-ups page shows reminders someone else closed, in words, until the assignee acknowledges each one.
const NOW = '2026-11-01T12:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notice = {
  followupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  patientId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  patientLabel: 'SYN-0020',
  medicationName: 'drug0',
  closedBy: 'person-colleague-7c2f',
  closedAt: NOW,
  note: 'Synthetic: covered at the visit',
  noteRedacted: false,
};
const emptyList = { currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: 0, unassigned: 0 } };

function open(notices: unknown[], acknowledgeStatus = 201) {
  let current = notices;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const at = new URL(String(input), 'http://synthetic');
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname === '/api/v1/followups/closures') return json({ items: current, total: current.length });
    if (at.pathname.endsWith('/acknowledge') && init?.method === 'POST') {
      if (acknowledgeStatus !== 201) return json({ error: { message: 'refused', details: [] } }, acknowledgeStatus);
      const body = JSON.parse(String(init.body));
      current = [];
      return json({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', followupId: body.followupId, threadId: notice.threadId, acknowledgedAt: NOW }, 201);
    }
    if (at.pathname === '/api/v1/followups') return json(emptyList);
    if (at.pathname === '/api/v1/followups/availability') return json({ recording: 'enabled' });
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports') || at.pathname.includes('/evaluations'))
      return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles: ['clinician'] });
  });
  const view = renderApp('/follow-ups', { signedInAs: ['clinician'], fetchImpl });
  return { ...view, fetchImpl };
}

describe('reminders closed by someone else (spec 045)', () => {
  it('the fixture is a valid notice list', () => {
    expect(() => followupClosureNoticesSchema.parse({ items: [notice], total: 1 })).not.toThrow();
  });

  it('shows who closed the reminder, when and why, in words, and acknowledging removes it', async () => {
    const view = open([notice]);
    const region = await screen.findByRole('region', { name: 'Closed by someone else' });
    const item = within(region).getByRole('listitem');
    expect(item).toHaveTextContent('SYN-0020 · drug0');
    expect(item).toHaveTextContent(/Closed by Clinician 7C2F on .+: Synthetic: covered at the visit/);
    expect(within(item).getByText('SYN-0020')).toHaveClass('slashed-zero');
    expect(await axe(view.container)).toHaveNoViolations();
    await userEvent.click(within(item).getByRole('button', { name: 'Acknowledge closure for SYN-0020' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Closed by someone else' })).not.toBeInTheDocument());
    const post = view.fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post?.[0])).toContain(`/api/v1/followups/${notice.threadId}/acknowledge`);
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ followupId: notice.followupId });
  });

  it('keeps the notice and says so when acknowledging fails', async () => {
    open([notice], 503);
    const region = await screen.findByRole('region', { name: 'Closed by someone else' });
    await userEvent.click(within(region).getByRole('button', { name: 'Acknowledge closure for SYN-0020' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent('Acknowledgement was not saved. Please retry.');
    expect(within(region).getByRole('listitem')).toBeInTheDocument();
  });

  it('shows nothing when no reminder of yours was closed by someone else', async () => {
    open([]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Follow-ups' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Closed by someone else' })).not.toBeInTheDocument());
  });
});
