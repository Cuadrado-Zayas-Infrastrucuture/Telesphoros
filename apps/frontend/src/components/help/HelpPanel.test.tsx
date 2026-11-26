import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Role } from '@telesphoros/shared-types';
import { HELP_EN } from '@telesphoros/help-content';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { HELP_WORDS } from '@/lib/helpWords';
import { HELP_EXCHANGE_LIMIT, HelpPanel } from './HelpPanel';

// Spec 051 slice H2, made a conversation by spec 053 slice C1. Hand-written expectations from spec 051 sections 2 to 5 and the C1 plan,
// section 2; the articles are the real drafts.
const titleOf = (id: string) => HELP_EN.articles.find((item) => item.id === id)!.title;
const panel = () => within(document.getElementById('help-panel')!);
const box = () => panel().getByRole('textbox', { name: HELP_WORDS.ask });
const conversation = () => within(panel().getByRole('log', { name: HELP_WORDS.conversation }));
const asked = () => conversation().queryAllByRole('listitem', { name: HELP_WORDS.you });
const answers = () => conversation().getAllByRole('listitem', { name: HELP_WORDS.helpSays });
const lastAnswer = () => within(answers().at(-1)!);
const PATIENT = '/patients/0f8fad5b-d9cb-469f-a165-70867728950e';

function show(pathname: string, roles: Role[]) {
  const onClose = vi.fn();
  const tree = (open: boolean) => (
    <MemoryRouter initialEntries={[pathname]}>
      <HelpPanel open={open} onClose={onClose} pathname={pathname} roles={roles} />
    </MemoryRouter>
  );
  const view = render(tree(true));
  const reopen = () => {
    view.rerender(tree(false));
    view.rerender(tree(true));
  };
  return { ...view, onClose, reopen };
}

it('opens on the articles for this page and these roles, before anything is asked', () => {
  show('/workspace', ['reader']);
  expect(panel().getByText(HELP_WORDS.intro)).toBeVisible();
  expect(panel().queryByRole('log')).not.toBeInTheDocument();
  const list = within(panel().getByRole('region', { name: HELP_WORDS.forThisPage }));
  expect(list.getByRole('button', { name: titleOf('the-worklist') })).toBeVisible();
  expect(list.getByRole('button', { name: titleOf('held-results') })).toBeVisible();
  // a reader does not read follow-ups and does not attach reports
  expect(list.queryByRole('button', { name: titleOf('follow-ups') })).not.toBeInTheDocument();
  expect(list.queryByRole('button', { name: titleOf('attach-a-report') })).not.toBeInTheDocument();
});

it("Enter sends: the question shows as the person's message and the best article is quoted under it; the box empties and keeps the focus", async () => {
  show('/workspace', ['reader']);
  await userEvent.type(box(), 'what is a held result{Enter}');
  expect(asked()).toHaveLength(1);
  expect(asked()[0]).toHaveTextContent('what is a held result');
  const quoted = within(lastAnswer().getByRole('article', { name: `${HELP_WORDS.from}: ${titleOf('held-results')}` }));
  for (const paragraph of HELP_EN.articles.find((item) => item.id === 'held-results')!.body) expect(quoted.getByText(paragraph)).toBeVisible();
  expect(quoted.getByText('Draft: not yet reviewed by a pharmacist.')).toBeVisible();
  expect(lastAnswer().getByText(HELP_WORDS.alsoInHelp)).toBeVisible();
  expect(box()).toHaveValue('');
  expect(box()).toHaveFocus();
});

it('Send sends too; a blank box sends nothing', async () => {
  show('/workspace', ['reader']);
  await userEvent.type(box(), '   ');
  await userEvent.click(panel().getByRole('button', { name: HELP_WORDS.send }));
  expect(panel().queryByRole('log')).not.toBeInTheDocument();
  expect(box()).toHaveFocus();
  await userEvent.type(box(), 'phenotype');
  await userEvent.click(panel().getByRole('button', { name: HELP_WORDS.send }));
  expect(lastAnswer().getByRole('article', { name: `${HELP_WORDS.word}: Phenotype` })).toBeVisible();
  expect(box()).toHaveFocus();
});

it("quotes an article with its links to the app's screens, and a link closes Help", async () => {
  const { onClose } = show('/workspace', ['clinician']);
  await userEvent.type(box(), 'overdue follow-up reminder{Enter}');
  const link = lastAnswer().getByRole('link', { name: 'Open Follow-ups' });
  expect(link).toHaveAttribute('href', '/follow-ups');
  await userEvent.click(link);
  expect(onClose).toHaveBeenCalled();
});

it('a chosen article joins the conversation with no message from the person, and the focus moves to it (C1-D1)', async () => {
  show('/workspace', ['clinician']);
  await userEvent.click(panel().getByRole('button', { name: titleOf('follow-ups') }));
  expect(asked()).toHaveLength(0);
  const heading = lastAnswer().getByRole('heading', { name: `${HELP_WORDS.from}: ${titleOf('follow-ups')}` });
  expect(heading).toHaveFocus();
  await userEvent.type(box(), 'what is a held result{Enter}');
  await userEvent.click(within(lastAnswer().getByRole('list', { name: HELP_WORDS.alsoInHelp })).getAllByRole('button')[0]);
  expect(asked()).toHaveLength(1);
  expect(answers()).toHaveLength(3);
  expect(lastAnswer().getByRole('heading', { level: 3 })).toHaveFocus();
});

it('says when no article answers, and offers the closest instead of guessing', async () => {
  show('/workspace', ['reader']);
  await userEvent.type(box(), 'zebra{Enter}');
  expect(lastAnswer().getByText(HELP_WORDS.weak)).toBeVisible();
  const closest = within(lastAnswer().getByRole('list', { name: HELP_WORDS.weak })).getAllByRole('button');
  expect(closest.length).toBeGreaterThan(0);
  expect(closest.length).toBeLessThanOrEqual(3);
  expect(lastAnswer().queryByRole('article')).not.toBeInTheDocument();
});

it('refuses a question about a patient before searching: the fixed sentence, no article, and on a patient page the way to their results', async () => {
  show(PATIENT, ['clinician']);
  await userEvent.type(box(), 'can my patient take clopidogrel{Enter}');
  expect(lastAnswer().getByText(HELP_EN.refusal!.body)).toBeVisible();
  expect(lastAnswer().queryByRole('article')).not.toBeInTheDocument();
  expect(lastAnswer().getByRole('link', { name: HELP_WORDS.patientResults })).toHaveAttribute('href', `${PATIENT}#patient-results`);
});

it('refuses on any other page too, without a link to a patient', async () => {
  show('/workspace', ['clinician']);
  await userEvent.type(box(), 'dose for SYN-0042{Enter}');
  expect(lastAnswer().getByText(HELP_EN.refusal!.body)).toBeVisible();
  expect(lastAnswer().queryByRole('link', { name: HELP_WORDS.patientResults })).not.toBeInTheDocument();
});

it('keeps the exchanges in order while open, and clears them when Help closes', async () => {
  const { onClose, reopen } = show('/workspace', ['reader']);
  await userEvent.type(box(), 'what is a held result{Enter}');
  await userEvent.type(box(), 'zebra{Enter}');
  expect(asked().map((item) => item.textContent)).toEqual([`${HELP_WORDS.you}what is a held result`, `${HELP_WORDS.you}zebra`]);
  await userEvent.type(box(), 'half typed');
  await userEvent.click(panel().getByRole('button', { name: HELP_WORDS.close }));
  expect(onClose).toHaveBeenCalled();
  reopen();
  expect(panel().queryByRole('log')).not.toBeInTheDocument();
  expect(box()).toHaveValue('');
  expect(panel().getByRole('region', { name: HELP_WORDS.forThisPage })).toBeVisible();
});

it(`keeps the last ${HELP_EXCHANGE_LIMIT} exchanges, and says so (C1-D2)`, async () => {
  show('/workspace', ['reader']);
  for (let n = 1; n <= HELP_EXCHANGE_LIMIT + 1; n += 1) await userEvent.type(box(), `zebra ${n}{Enter}`);
  expect(asked()).toHaveLength(HELP_EXCHANGE_LIMIT);
  expect(asked()[0]).toHaveTextContent('zebra 2');
  expect(asked().at(-1)).toHaveTextContent(`zebra ${HELP_EXCHANGE_LIMIT + 1}`);
  expect(panel().getByText(HELP_WORDS.limit)).toBeVisible();
}, 20_000);

it('has no WCAG A/AA violation, before anything is asked and with three exchanges', async () => {
  const { container } = show(PATIENT, ['clinician']);
  expect(await axe(container)).toHaveNoViolations();
  await userEvent.type(box(), 'what is a held result{Enter}');
  await userEvent.type(box(), 'zebra{Enter}');
  await userEvent.type(box(), 'can my patient take clopidogrel{Enter}');
  expect(await axe(container)).toHaveNoViolations();
});

const EMPTY_COUNTS = { overdue: 0, today: 0, upcoming: 0, unassigned: 0 };
const EMPTY_PAGE = { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** The sidebar's navigation, once sign-in has finished: before that, the signed-out header has its own "Primary" navigation (as WorkspaceSidebar.test). */
async function sidebarNav() {
  await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
  return within(screen.getByRole('navigation', { name: 'Primary' }));
}

function openApp(roles: Role[]) {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const at = new URL(String(url), 'http://synthetic');
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname === '/api/v1/followups') return json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: EMPTY_COUNTS });
    // The worklist's and the sidebar's reads; anything else, the sign-in's /me included, answers with the roles.
    if (at.pathname === '/api/v1/evaluations' || at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json(EMPTY_PAGE);
    return json({ roles });
  });
  return { ...renderApp('/workspace', { signedInAs: roles, fetchImpl }), fetchImpl };
}

it('opens from the sidebar on every signed-in page, closes, and returns the focus to Help', async () => {
  openApp(['clinician']);
  const help = (await sidebarNav()).getByRole('button', { name: HELP_WORDS.button });
  await userEvent.click(help);
  expect(await screen.findByRole('dialog', { name: HELP_WORDS.title })).toBeVisible();
  expect(panel().getByRole('heading', { level: 2, name: HELP_WORDS.title })).toHaveFocus();
  await userEvent.click(panel().getByRole('button', { name: HELP_WORDS.close }));
  expect(document.getElementById('help-panel')).not.toHaveAttribute('open');
  expect(help).toHaveFocus();
});

it('sends nothing and stores nothing while the person asks, refused questions included (section 2)', async () => {
  const { fetchImpl } = openApp(['clinician']);
  await userEvent.click((await sidebarNav()).getByRole('button', { name: HELP_WORDS.button }));
  await screen.findByRole('dialog', { name: HELP_WORDS.title });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  const before = fetchImpl.mock.calls.length;
  const stored = { local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }) };
  const address = window.location.href;
  await userEvent.type(box(), 'held result{Enter}');
  await userEvent.type(box(), 'can my patient take clopidogrel{Enter}');
  expect(answers()).toHaveLength(2);
  expect(fetchImpl.mock.calls.length).toBe(before);
  expect({ local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }) }).toEqual(stored);
  expect(window.location.href).toBe(address);
});
