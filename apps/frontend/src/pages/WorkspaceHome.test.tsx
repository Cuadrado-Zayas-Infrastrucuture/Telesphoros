import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { followupListSchema, type Role } from '@telesphoros/shared-types';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Specs/038 D19: the home lists the follow-ups assigned to the person signed in, from the inbox read. Synthetic data only.

const NOW = '2026-11-12T12:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// A name on the FDA Tall Man list, read from the list itself, so the expected spelling does not come from the code under test.
const TALL: string = (JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/shared-types/src/drug-list/fda-tall-man.json'), 'utf8')) as { names: string[] }).names[0]!;
const entry = (index: number, dueState: 'overdue' | 'today' | 'upcoming', date: string) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
  threadId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`,
  patientId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`,
  patientLabel: `SYN-HOME-${index}`,
  medicationId: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index}`,
  medicationName: index === 0 ? TALL.toLowerCase() : `drug${index}`,
  decisionId: null,
  version: 1,
  action: 'schedule',
  assessment: null,
  note: 'Synthetic reminder.',
  noteRedacted: false,
  next: { date, timezone: 'America/Puerto_Rico', assignee: 'person-1' },
  createdAt: NOW,
  createdBy: 'person-1',
  current: true,
  dueState,
  needsReassignment: false,
});
const list = (items: unknown[], hasMore = false) => ({ currentActor: 'person-1', items, page: 1, hasMore, counts: { overdue: 1, today: 1, upcoming: 2, unassigned: 0 } });

function open(roles: Role[], mine: () => Response) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url), 'http://synthetic');
    if (at.pathname === '/api/v1/followups') return at.searchParams.get('assignment') === 'mine' ? mine() : json(list([]));
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles });
  });
  const view = renderApp('/workspace', { signedInAs: roles, fetchImpl });
  return { ...view, fetchImpl };
}
const section = async () => within(await screen.findByRole('region', { name: 'Follow-ups assigned to you' }));

it('the fixture is a valid follow-up list', () => {
  expect(() => followupListSchema.parse(list([entry(0, 'overdue', '2026-11-01')]))).not.toThrow();
});

it('lists the follow-ups assigned to the clinician: patient, medication, when it is due and where, and the way to open each', async () => {
  const items = [entry(0, 'overdue', '2026-11-01'), entry(1, 'today', '2026-11-12'), entry(2, 'upcoming', '2026-11-20'), entry(3, 'upcoming', '2026-11-30')];
  const { container, fetchImpl } = open(['clinician'], () => json(list(items)));
  const home = await section();
  const first = await home.findByRole('link', { name: `Open follow-up for SYN-HOME-0, ${TALL.toLowerCase()}` });
  expect(first).toHaveAttribute('href', `/patients/${items[0]!.patientId}?followup=${items[0]!.threadId}#followups`);
  expect(first).toHaveTextContent(`SYN-HOME-0 · ${TALL}`); // a look-alike name is shown in its Tall Man form
  expect(home.getByText('Overdue · 2026-11-01 (America/Puerto_Rico)')).toHaveClass('text-warning');
  expect(home.getByText('Due today · 2026-11-12 (America/Puerto_Rico)')).not.toHaveClass('text-warning');
  // A starting point, not the list: three rows, and where the rest are.
  expect(home.getAllByRole('link')).toHaveLength(3);
  expect(home.getByText('There are more. The full list, with its filters, is under Follow-ups in the sidebar.')).toBeVisible();
  // An overdue reminder is a late task, and the section says it is not a clinical warning.
  expect(home.getByText('Overdue means the reminder’s date has passed. It is not a clinical warning.')).toBeVisible();
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/api/v1/followups?') && String(url).includes('assignment=mine'))).toBe(true);
  expect(await axe(container)).toHaveNoViolations();
});

it('says so when nothing is assigned, and makes no claim about overdue', async () => {
  open(['clinician'], () => json(list([])));
  const home = await section();
  expect(await home.findByText('No open follow-ups are assigned to you.')).toBeVisible();
  expect(home.queryByText(/Overdue/)).not.toBeInTheDocument();
  expect(home.queryByRole('link')).not.toBeInTheDocument();
});

it('a failed read lists nothing, says so, and can be retried', async () => {
  let down = true;
  open(['clinician'], () => (down ? json({ error: { code: 'UNAVAILABLE' } }, 503) : json(list([entry(1, 'today', '2026-11-12')]))));
  const home = await section();
  expect(await home.findByText('Follow-ups could not be loaded, so none are listed here.')).toBeVisible();
  expect(home.queryByText('No open follow-ups are assigned to you.')).not.toBeInTheDocument();
  down = false;
  await userEvent.click(home.getByRole('button', { name: 'Retry follow-ups' }));
  expect(await home.findByRole('link', { name: 'Open follow-up for SYN-HOME-1, drug1' })).toBeVisible();
});

it('a reviewer sees the same section; a reader and a member with no role do not, and no such read is made for them', async () => {
  const reviewer = open(['reviewer'], () => json(list([])));
  expect(await (await section()).findByText('No open follow-ups are assigned to you.')).toBeVisible();
  reviewer.unmount();
  for (const roles of [['reader'], []] as Role[][]) {
    const view = open(roles, () => json(list([entry(0, 'overdue', '2026-11-01')])));
    await screen.findByRole('heading', { level: 1, name: 'Start with a synthetic report.' });
    expect(screen.queryByRole('region', { name: 'Follow-ups assigned to you' })).not.toBeInTheDocument();
    expect(view.fetchImpl.mock.calls.some(([url]) => String(url).includes('assignment=mine'))).toBe(false);
    view.unmount();
  }
});
