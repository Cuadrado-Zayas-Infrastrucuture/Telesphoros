import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Role } from '@telesphoros/shared-types';
import { HELP_EN } from '@telesphoros/help-content';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { HELP_WORDS } from '@/lib/helpWords';
import { HelpPanel } from './HelpPanel';

// Spec 051 slice H2: the help panel. Hand-written expectations from the specification (sections 2 to 5); the articles are the real drafts.
const titleOf = (id: string) => HELP_EN.articles.find((item) => item.id === id)!.title;
const panel = () => within(document.getElementById('help-panel')!);
const search = () => panel().getByRole('searchbox', { name: HELP_WORDS.search });

function show(pathname: string, roles: Role[]) {
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[pathname]}>
      <HelpPanel open onClose={onClose} pathname={pathname} roles={roles} />
    </MemoryRouter>,
  );
  return { ...view, onClose };
}

it('opens on the articles for this page and these roles', () => {
  show('/workspace', ['reader']);
  const list = within(panel().getByRole('region', { name: HELP_WORDS.forThisPage }));
  expect(list.getByRole('button', { name: titleOf('the-worklist') })).toBeVisible();
  expect(list.getByRole('button', { name: titleOf('held-results') })).toBeVisible();
  // a reader does not read follow-ups and does not attach reports
  expect(list.queryByRole('button', { name: titleOf('follow-ups') })).not.toBeInTheDocument();
  expect(list.queryByRole('button', { name: titleOf('attach-a-report') })).not.toBeInTheDocument();
});

it('opens an article with its paragraphs, its links to app screens, and the draft line; Back returns to the list', async () => {
  show('/workspace', ['clinician']);
  await userEvent.click(panel().getByRole('button', { name: titleOf('follow-ups') }));
  const opened = within(panel().getByRole('article', { name: titleOf('follow-ups') }));
  for (const paragraph of HELP_EN.articles.find((item) => item.id === 'follow-ups')!.body) expect(opened.getByText(paragraph)).toBeVisible();
  expect(opened.getByRole('link', { name: 'Open Follow-ups' })).toHaveAttribute('href', '/follow-ups');
  expect(opened.getByText('Draft: not yet reviewed by a pharmacist.')).toBeVisible();
  await userEvent.click(opened.getByRole('button', { name: HELP_WORDS.back }));
  expect(panel().getByRole('region', { name: HELP_WORDS.forThisPage })).toBeVisible();
});

it('searches as the person types, articles and glossary words together', async () => {
  show('/patients/0f8fad5b-d9cb-469f-a165-70867728950e', ['reader']);
  await userEvent.type(search(), 'what is a held result');
  const results = within(panel().getByRole('region', { name: HELP_WORDS.results }));
  expect(results.getAllByRole('button')[0]).toHaveAccessibleName(titleOf('held-results'));
  await userEvent.clear(search());
  await userEvent.type(search(), 'phenotype');
  expect(within(panel().getByRole('region', { name: HELP_WORDS.results })).getByRole('button', { name: `${HELP_WORDS.word}: Phenotype` })).toBeVisible();
});

it('says when no article answers, and offers the closest instead of guessing', async () => {
  show('/workspace', ['reader']);
  await userEvent.type(search(), 'zebra');
  const results = within(panel().getByRole('region', { name: HELP_WORDS.results }));
  expect(results.getByText(HELP_WORDS.weak)).toBeVisible();
  expect(results.getAllByRole('button').length).toBeGreaterThan(0);
  expect(results.getAllByRole('button').length).toBeLessThanOrEqual(3);
});

it('refuses a question about a patient before searching: the fixed sentence, no results, and on a patient page the way to their results', async () => {
  const patient = '/patients/0f8fad5b-d9cb-469f-a165-70867728950e';
  show(patient, ['clinician']);
  await userEvent.type(search(), 'can my patient take clopidogrel');
  expect(panel().getByRole('status')).toHaveTextContent(HELP_EN.refusal!.body);
  expect(panel().queryByRole('region', { name: HELP_WORDS.results })).not.toBeInTheDocument();
  expect(panel().getByRole('link', { name: HELP_WORDS.patientResults })).toHaveAttribute('href', `${patient}#patient-results`);
});

it('refuses on any other page too, without a link to a patient', async () => {
  show('/workspace', ['clinician']);
  await userEvent.type(search(), 'dose for SYN-0042');
  expect(panel().getByRole('status')).toHaveTextContent(HELP_EN.refusal!.body);
  expect(panel().queryByRole('link', { name: HELP_WORDS.patientResults })).not.toBeInTheDocument();
});

it('has no WCAG A/AA violation, listing or with an article open', async () => {
  const { container } = show('/workspace', ['clinician']);
  expect(await axe(container)).toHaveNoViolations();
  await userEvent.click(panel().getByRole('button', { name: titleOf('held-results') }));
  expect(await axe(container)).toHaveNoViolations();
});

const EMPTY_COUNTS = { overdue: 0, today: 0, upcoming: 0, unassigned: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function openApp(roles: Role[]) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url), 'http://synthetic');
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname === '/api/v1/followups') return json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: EMPTY_COUNTS });
    if (at.pathname.startsWith('/api/v1/')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles });
  });
  return { ...renderApp('/workspace', { signedInAs: roles, fetchImpl }), fetchImpl };
}

it('opens from the sidebar on every signed-in page, closes, and returns the focus to Help', async () => {
  openApp(['clinician']);
  const help = within(await screen.findByRole('navigation', { name: 'Primary' })).getByRole('button', { name: HELP_WORDS.button });
  await userEvent.click(help);
  expect(await screen.findByRole('dialog', { name: HELP_WORDS.title })).toBeVisible();
  expect(panel().getByRole('heading', { level: 2, name: HELP_WORDS.title })).toHaveFocus();
  await userEvent.click(panel().getByRole('button', { name: HELP_WORDS.close }));
  expect(document.getElementById('help-panel')).not.toHaveAttribute('open');
  expect(help).toHaveFocus();
});

it('sends nothing and stores nothing while the person types (section 2)', async () => {
  const { fetchImpl } = openApp(['clinician']);
  await userEvent.click(within(await screen.findByRole('navigation', { name: 'Primary' })).getByRole('button', { name: HELP_WORDS.button }));
  await screen.findByRole('dialog', { name: HELP_WORDS.title });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  const before = fetchImpl.mock.calls.length;
  const stored = { local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }) };
  await userEvent.type(search(), 'held result');
  await userEvent.clear(search());
  await userEvent.type(search(), 'can my patient take clopidogrel');
  expect(fetchImpl.mock.calls.length).toBe(before);
  expect({ local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }) }).toEqual(stored);
});
