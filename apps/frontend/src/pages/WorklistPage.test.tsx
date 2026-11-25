import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { evaluationSummaryDtoSchema, type Role } from '@telesphoros/shared-types';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Spec 049 W2: the worklist home. Hand-written expectations from the specification's rules (WL-1 to WL-7); invented labels and a held
// evaluation that the shared schema accepts. Synthetic data only.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const patient = (index: number) => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`;
const held = (index: number) => ({
  id: `66666666-6666-4666-8666-66666666666${index}`,
  reportId: `11111111-1111-4111-8111-11111111111${index}`,
  patientId: patient(index),
  captureId: null,
  acceptance: null,
  disposition: 'held',
  holdCode: 'gene-absent',
  hold: { message: 'A needed gene result is missing.', reviewerAction: 'Ask the laboratory for it.' },
  knowledgeSetId: 'a'.repeat(64),
  engineVersion: 'sha256-abcdef012345',
  scope: 'synthetic-structured-assessment',
  clinicalUse: 'not-approved',
  state: 'active',
  supersededBy: null,
  results: [],
  geneStates: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified', knowledge: { evaluatedWith: 'set', loadedNow: 'set', status: 'same' } },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
});
const page = (data: unknown[], total = data.length) => json({ data, meta: { page: 1, pageSize: 5, total, totalPages: Math.ceil(total / 5) } });
const followups = () => json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: 0, unassigned: 0 } });

const labelled = (id: string) => json({ id, label: `SYN-HELD-${id.slice(-1)}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', mergedInto: null });

function open(roles: Role[], answers: { evaluations?: () => Response; followups?: () => Response; patient?: (id: string) => Response } = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url), 'http://synthetic');
    if (at.pathname === '/api/v1/evaluations') return (answers.evaluations ?? (() => page([])))();
    if (at.pathname === '/api/v1/followups') return (answers.followups ?? followups)();
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    const one = /^\/api\/v1\/patients\/([0-9a-f-]{36})$/.exec(at.pathname);
    if (one) return (answers.patient ?? labelled)(one[1]!);
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles });
  });
  const view = renderApp('/workspace', { signedInAs: roles, fetchImpl });
  return { ...view, fetchImpl };
}
const pathOf = (url: unknown) => new URL(String(url), 'http://synthetic').pathname;
const requested = (fetchImpl: ReturnType<typeof open>['fetchImpl'], path: string) => fetchImpl.mock.calls.filter(([url]) => pathOf(url) === path);
const heldSection = async () => within(await screen.findByRole('region', { name: 'Held results' }));

it('the held fixture is a valid evaluation summary', () => {
  expect(() => evaluationSummaryDtoSchema.parse(held(0))).not.toThrow();
});

it('is the home: its heading, the quick actions a clinician may use, then follow-ups and held results, in that order', async () => {
  const { container } = open(['clinician']);
  expect(await screen.findByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
  const start = within(screen.getByRole('group', { name: 'Start here' }));
  expect(start.getByRole('link', { name: 'Find a patient' })).toHaveAttribute('href', '/patients');
  expect(start.getByRole('link', { name: 'Add a patient' })).toHaveAttribute('href', '/patients/new');
  expect(start.getByRole('link', { name: 'Attach a report' })).toHaveAttribute('href', '/reports/upload');
  await heldSection();
  const sections = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
  expect(sections.indexOf('Follow-ups assigned to you')).toBeLessThan(sections.indexOf('Held results'));
  expect(await axe(container)).toHaveNoViolations();
});

it('lists held results: the patient, the hold in its fixed words, the way to the patient’s results, and the server’s own total (WL-4)', async () => {
  const { fetchImpl } = open(['clinician'], { evaluations: () => page([held(0), held(1)], 7) });
  const section = await heldSection();
  const first = await section.findByRole('link', { name: 'Open held result for SYN-HELD-0' });
  expect(first).toHaveAttribute('href', `/patients/${patient(0)}#patient-results`);
  expect(section.getByRole('link', { name: 'Open held result for SYN-HELD-1' })).toBeVisible();
  expect(section.getAllByText('A needed gene result is missing. Ask the laboratory for it.')).toHaveLength(2);
  // 7 is the server's count, not the 2 rows shown.
  expect(section.getByText('7 held results in all. Each patient’s page lists their own.')).toBeVisible();
  const [url] = requested(fetchImpl, '/api/v1/evaluations').map(([call]) => new URL(String(call), 'http://synthetic'));
  expect(url!.searchParams.get('disposition')).toBe('held');
  expect(url!.searchParams.get('current')).toBe('true');
  expect(url!.searchParams.get('pageSize')).toBe('5');
});

it('says no count line when every held result is shown', async () => {
  open(['reader'], { evaluations: () => page([held(0)]) });
  const section = await heldSection();
  await section.findByRole('link', { name: 'Open held result for SYN-HELD-0' });
  expect(section.queryByText(/held results in all/)).not.toBeInTheDocument();
});

it('shows the identifier when a patient’s label cannot be read, as the Reports list does (WL-9)', async () => {
  open(['clinician'], { evaluations: () => page([held(2)]), patient: () => json({ error: { code: 'NOT_FOUND' } }, 404) });
  const section = await heldSection();
  expect(await section.findByRole('link', { name: `Open held result for ${patient(2)}` })).toHaveAttribute('href', `/patients/${patient(2)}#patient-results`);
});

it('an empty list says so in its fixed sentence (WL-3)', async () => {
  open(['clinician']);
  const section = await heldSection();
  expect(await section.findByText('No results are held.')).toBeVisible();
  expect(section.queryByRole('link')).not.toBeInTheDocument();
});

it('a failed read says so, never looks empty, and its Retry reads held results only (WL-2)', async () => {
  let down = true;
  const { fetchImpl } = open(['clinician'], { evaluations: () => (down ? json({ error: { code: 'INTERNAL' } }, 500) : page([held(0)])) });
  const section = await heldSection();
  expect(await section.findByText('Held results could not be loaded.')).toBeVisible();
  expect(section.queryByText('No results are held.')).not.toBeInTheDocument();
  const before = requested(fetchImpl, '/api/v1/followups').length;
  down = false;
  await userEvent.click(section.getByRole('button', { name: 'Retry held results' }));
  expect(await section.findByRole('link', { name: 'Open held result for SYN-HELD-0' })).toBeVisible();
  expect(requested(fetchImpl, '/api/v1/followups')).toHaveLength(before);
});

it('an answer that is not a list of current held results is a failure, not a list', async () => {
  open(['clinician'], { evaluations: () => page([{ ...held(0), disposition: 'evaluated', holdCode: null, hold: null }]) });
  expect(await (await heldSection()).findByText('Held results could not be loaded.')).toBeVisible();
});

it('a route switched off in this environment is a state, with no retry and no empty sentence (WL-7)', async () => {
  open(['clinician'], { evaluations: () => json({ error: { code: 'PIPELINE_DISABLED', message: 'Lab report processing is switched off.' } }, 503) });
  const section = await heldSection();
  expect(await section.findByText('Held results are not available in this environment.')).toBeVisible();
  expect(section.queryByRole('button')).not.toBeInTheDocument();
  expect(section.queryByText('No results are held.')).not.toBeInTheDocument();
});

it('one section failing leaves the other standing (WL-1)', async () => {
  open(['clinician'], { followups: () => json({ error: { code: 'UNAVAILABLE' } }, 503), evaluations: () => page([held(0)]) });
  expect(await (await heldSection()).findByRole('link', { name: 'Open held result for SYN-HELD-0' })).toBeVisible();
  const followupSection = within(await screen.findByRole('region', { name: 'Follow-ups assigned to you' }));
  expect(await followupSection.findByText('Follow-ups could not be loaded.')).toBeVisible();
});

it('shows each section only to the roles that read it, and asks nothing for the others (WL-6)', async () => {
  const reader = open(['reader']);
  await heldSection();
  expect(screen.queryByRole('region', { name: 'Follow-ups assigned to you' })).not.toBeInTheDocument();
  expect(requested(reader.fetchImpl, '/api/v1/followups')).toHaveLength(0);
  const start = within(screen.getByRole('group', { name: 'Start here' }));
  expect(start.getAllByRole('link').map((link) => link.textContent)).toEqual(['Find a patient']);
  reader.unmount();

  const nobody = open([]);
  expect(await screen.findByText('Your account has no clinical role, so there is no work to show here.')).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Held results' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Start here' })).not.toBeInTheDocument();
  expect(requested(nobody.fetchImpl, '/api/v1/evaluations')).toHaveLength(0);
  expect(requested(nobody.fetchImpl, '/api/v1/followups')).toHaveLength(0);
});

it('never says "safe", "no interaction", "not affected" or "none" in any state (WL-3)', async () => {
  const states: (() => Response)[] = [
    () => page([]),
    () => page([held(0), held(1)], 9),
    () => json({ error: { code: 'INTERNAL' } }, 500),
    () => json({ error: { code: 'PIPELINE_DISABLED' } }, 503),
  ];
  for (const evaluations of states) {
    const view = open(['clinician'], { evaluations });
    const section = await heldSection();
    await vi.waitFor(() => expect(section.queryByText('Loading held results…')).not.toBeInTheDocument());
    // The worklist alone: the chat stays mounted, hidden, beside it (WorkspacePage), and is not what this rule is about.
    const worklist = screen.getByRole('heading', { level: 1, name: 'Your worklist' }).parentElement!.parentElement!;
    const text = (worklist.textContent ?? '').toLowerCase();
    for (const word of ['safe', 'no interaction', 'not affected', 'none']) expect(text, word).not.toContain(word);
    view.unmount();
  }
});
