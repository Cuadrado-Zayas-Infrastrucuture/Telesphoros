import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@telesphoros/shared-types';
import { API, renderApp } from '@/test/authTestUtils';
import { downloadReport } from '@/lib/ownedStorageApi';
vi.mock('@/lib/storageMode', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/storageMode')>(), ownedStorageMode: () => true }));
vi.mock('@/lib/ownedStorageApi', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/ownedStorageApi')>(), downloadReport: vi.fn(async () => undefined) }));
beforeEach(() => vi.mocked(downloadReport).mockReset());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const p1 = '11111111-1111-4111-8111-111111111111', p2 = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-12T00:00:00Z';
const row = (patientId = p1, fileUploaded = true) => ({ id: '33333333-3333-4333-8333-333333333333', patientId, type: 'vcf', filename: 'synthetic.vcf', sizeBytes: 8, status: 'received', fileUploaded, contentType: fileUploaded ? 'text/x-vcf' : null, sha256: fileUploaded ? 'a'.repeat(64) : null, createdAt: date, updatedAt: date });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function fetcher(roles: Role[], reports: (url: URL) => Promise<Response> = async url => json({ data: [row(url.searchParams.get('patientId') || p1)], meta: { page: Number(url.searchParams.get('page')), pageSize: 20, total: 21, totalPages: 2 } })) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me')) return json({ roles });
    if (url.pathname.endsWith('/patients')) return json({ data: [p1, p2].map((id, i) => ({ id, label: `SYN-${i + 1}`, createdAt: date, updatedAt: date })), meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } });
    return reports(url);
  });
}
const heading = () => screen.findByRole('heading', { level: 1, name: 'Reports' });
describe('reports page with real auth and route guards', () => {
  it.each([['clinician'], ['reviewer'], ['reader'], ['admin']] as Role[][])('makes the synthetic assistant discoverable before selecting a report for %j', async (...roles: Role[]) => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    const { container } = renderApp('/reports', { signedInAs: roles, fetchImpl: fetcher(roles) });
    await heading();
    expect(screen.getByRole('region', { name: 'Report details' })).toHaveTextContent('Select a report');
    const preview = within(await screen.findByRole('region', { name: 'AI-assisted PGx preview' }));
    expect(preview.getByRole('textbox', { name: 'Sample question' })).toBeInTheDocument();
    expect(preview.getByText(/No live model or CPIC mapping/)).toBeInTheDocument();
    await userEvent.setup().click(preview.getByText('Example context and tools'));
    expect(Boolean(preview.queryByRole('button', { name: 'Choose file' }))).toBe(roles.some(role => ['clinician', 'admin'].includes(role)));
    expect(screen.getByRole('link', { name: 'AI preview' })).toBeInTheDocument();
    expect(Boolean(screen.queryByRole('link', { name: 'Upload synthetic report' }))).toBe(roles.some(role => ['clinician', 'admin'].includes(role)));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    const detail = within(screen.getByRole('region', { name: 'Report details' }));
    expect(detail.getByText('Yes — server verified')).toBeInTheDocument();
    expect(Boolean(detail.queryByRole('button', { name: 'Download synthetic.vcf' }))).toBe(roles.some(role => ['clinician', 'reviewer', 'admin'].includes(role)));
    await userEvent.setup().click(detail.getByText('Technical details'));
    expect(detail.getByText(/does not establish capture acceptance/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
  it('keeps secondary questions discoverable and restores focus when the compact question menu closes', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    renderApp('/reports', { signedInAs: ['clinician'], fetchImpl: fetcher(['clinician']) }); await heading();
    const preview = within(await screen.findByRole('region', { name: 'AI-assisted PGx preview' }));
    const user = userEvent.setup(), trigger = preview.getByText('Questions');
    const menu = trigger.closest('details')!;
    expect(menu).not.toHaveAttribute('open');
    await user.click(trigger); expect(menu).toHaveAttribute('open');
    await user.keyboard('{Escape}'); expect(menu).not.toHaveAttribute('open'); expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(preview.getByRole('button', { name: 'What are the limitations?' }));
    await preview.findByText(/^These words are/);
    expect(menu).not.toHaveAttribute('open');
    expect(preview.getByRole('textbox', { name: 'Sample question' })).toHaveFocus();
  });
  it('runs inline, retains the sample across report selection and collapse, and resets without sending report data', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    const outbound = vi.fn(); vi.stubGlobal('fetch', outbound);
    const { router } = renderApp('/reports', { signedInAs: ['clinician'], fetchImpl: fetcher(['clinician']) });
    await heading();
    const preview = within(await screen.findByRole('region', { name: 'AI-assisted PGx preview' }));
    const user = userEvent.setup();
    await user.click(preview.getByText('Questions'));
    await user.click(preview.getByRole('button', { name: 'What evidence is missing?' }));
    await preview.findByText(/^This example has no accepted/);
    await user.click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    expect(router.state.location.pathname).toBe('/reports');
    expect(preview.getByText(/^This example has no accepted/)).toBeInTheDocument();
    expect(preview.queryByText('synthetic.vcf')).not.toBeInTheDocument();
    await user.click(preview.getByText('AI-assisted PGx preview', { exact: true }));
    expect(preview.getByText('AI-assisted PGx preview', { exact: true }).closest('details')).not.toHaveAttribute('open');
    await user.click(screen.getByRole('link', { name: 'AI preview' }));
    expect(preview.getByText(/^This example has no accepted/)).toBeInTheDocument();
    expect(preview.getByText('AI-assisted PGx preview', { exact: true })).toHaveFocus();
    await user.click(preview.getByRole('button', { name: 'Reset' }));
    await preview.findByRole('img', { name: 'Telesphoros mascot in a teal cloak' });
    expect(preview.getByRole('textbox', { name: 'Sample question' })).toHaveFocus();
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each([
    { hostname: 'localhost', dev: true },
    { hostname: 'example.com', dev: true },
    { hostname: '127.0.0.1', dev: false },
  ])('does not offer the assistant outside the permitted development host: %j', async ({ hostname, dev }) => {
    vi.stubGlobal('location', { hostname }); vi.stubEnv('DEV', dev);
    renderApp('/reports', { signedInAs: ['clinician'], fetchImpl: fetcher(['clinician']) }); await heading();
    expect(screen.queryByRole('region', { name: 'AI-assisted PGx preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'AI preview' })).not.toBeInTheDocument();
  });
  it('redirects an anonymous visitor and preserves the return path', async () => {
    const { client } = renderApp('/reports'); await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(client.signIn).toHaveBeenCalledWith('/reports');
  });
  it.each([['reviewer'], ['reader'], ['clinician'], ['admin'], ['reviewer', 'clinician']] as Role[][])('uses additive roles %j without adding a role preview control', async (...roles: Role[]) => {
    renderApp('/reports', { signedInAs: roles, fetchImpl: fetcher(roles) }); await heading();
    await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    expect(Boolean(screen.queryByRole('link', { name: 'Upload synthetic report' }))).toBe(roles.some(role => ['clinician', 'admin'].includes(role)));
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Open synthetic.vcf' }));
    expect(Boolean(screen.queryByRole('button', { name: 'Download synthetic.vcf' }))).toBe(roles.some(role => ['clinician', 'reviewer', 'admin'].includes(role)));
    expect(screen.queryByLabelText('Preview roles')).not.toBeInTheDocument();
  });
  it('keeps upload verification separate from received status, with keyboard-accessible details', async () => {
    const { container } = renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: fetcher(['reviewer']) });
    await heading(); await userEvent.setup().click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    const detail = within(screen.getByRole('region', { name: 'Report details' }));
    expect(detail.getByText('received')).toBeInTheDocument(); expect(detail.getByText('Yes — server verified')).toBeInTheDocument();
    expect(detail.getByText(/does not establish capture acceptance/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
  it('clears selection while changing page/patient and ignores an old late response', async () => {
    let finish: (value: Response) => void = () => {}; let pageTwoRead = false;
    const api = fetcher(['reviewer'], async url => {
      if (url.searchParams.get('page') === '2') { pageTwoRead = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return json({ data: [row(url.searchParams.get('patientId') || p1)], meta: { page: 1, pageSize: 20, total: 21, totalPages: 2 } });
    });
    renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: api }); await heading();
    const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    await user.click(screen.getByRole('button', { name: 'Next report page' }));
    await waitFor(() => expect(pageTwoRead).toBe(true));
    expect(screen.queryByText('Yes — server verified')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by patient'), p2);
    await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    finish(json({ data: [row(p1, false)], meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 } }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(`${API}/api/v1/reports?page=1&pageSize=20&patientId=${p2}`, expect.anything()));
    expect(screen.queryByText('Not complete')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Report details' })).toHaveTextContent('Select a report');
  });
  it('sanitizes errors, offers retry and handles an empty result', async () => {
    let attempts = 0;
    renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: fetcher(['reviewer'], async () => ++attempts === 1 ? json({ message: 'do-not-display' }, 503) : json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })) });
    await heading(); expect(await screen.findByRole('alert')).toHaveTextContent('Reports could not be loaded');
    expect(screen.queryByText('do-not-display')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry loading reports' }));
    expect(await screen.findByText('No reports found for this selection.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report records' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Next report page' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('keeps page controls mounted and focused through slow reads and refusal without stale rows', async () => {
    let finish: (value: Response) => void = () => {};
    const api = fetcher(['reviewer'], async url => url.searchParams.get('page') === '2'
      ? new Promise<Response>(resolve => { finish = resolve; })
      : json({ data: [row()], meta: { page: 1, pageSize: 20, total: 21, totalPages: 2 } }));
    renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: api });
    await heading(); await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    const user = userEvent.setup(), next = screen.getByRole('button', { name: 'Next report page' });
    await user.click(next);
    expect(next).toHaveFocus(); expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('region', { name: 'Report records table' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading reports…')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: 'Open synthetic.vcf' })).not.toBeInTheDocument();
    await user.click(next); // In-flight controls cannot launch a duplicate request.
    expect(api.mock.calls.filter(([url]) => String(url).includes('/reports?page=2'))).toHaveLength(1);
    finish(json({ message: 'do-not-display' }, 503));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Next report page' })).toBe(next);
    expect(next).toHaveFocus(); expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Report page unavailable.')).toBeInTheDocument();
  });
  it('focuses selected details, exposes technical fields on request and returns to the same report', async () => {
    renderApp('/reports', { signedInAs: ['reader'], fetchImpl: fetcher(['reader']) }); await heading();
    const user = userEvent.setup(), trigger = await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    await user.click(trigger);
    expect(screen.getByRole('heading', { name: 'Report details' })).toHaveFocus();
    const disclosure = screen.getByText('Technical details').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(screen.getByText('Technical details')); expect(disclosure).toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Back to reports' }));
    await waitFor(() => expect(trigger).toHaveFocus()); expect(screen.queryByText('Yes — server verified')).not.toBeInTheDocument();
  });
  it('clears a patient filter during a slow read without losing focus or restoring a late result', async () => {
    let finish: (value: Response) => void = () => {};
    const api = fetcher(['reader'], async url => url.searchParams.has('patientId')
      ? new Promise<Response>(resolve => { finish = resolve; })
      : json({ data: [row()], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }));
    const { container } = renderApp('/reports', { signedInAs: ['reader'], fetchImpl: api });
    const user = userEvent.setup(); await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    await user.selectOptions(screen.getByLabelText('Filter by patient'), p2);
    const table = screen.getByRole('region', { name: 'Report records table' });
    expect(table).toHaveAttribute('aria-busy', 'true');
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Clear patient filter' }));
    await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    expect(screen.getByRole('heading', { name: 'Report records' })).toHaveFocus();
    expect(screen.getByLabelText('Filter by patient')).toHaveValue('');
    expect(table).toHaveAttribute('aria-busy', 'false');
    finish(json({ data: [row(p2, false)], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }));
    await waitFor(() => expect(api.mock.calls.filter(([url]) => String(url).includes('/reports?'))).toHaveLength(3));
    expect(screen.queryByText('Not complete')).not.toBeInTheDocument();
  });
  it.each([['reader', false], ['reviewer', false], ['clinician', true], ['admin', true]] as const)('offers empty-state upload only for an existing writer role: %s', async (role, allowed) => {
    renderApp('/reports', { signedInAs: [role], fetchImpl: fetcher([role], async () => json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })) });
    await screen.findByText('No reports found for this selection.');
    expect(Boolean(screen.queryByRole('link', { name: 'Upload first synthetic report' }))).toBe(allowed);
  });
  it('returns an emptied later page to page one while retaining the patient filter', async () => {
    const api = fetcher(['reviewer'], async url => json({ data: url.searchParams.get('page') === '2' ? [] : [row(p2)], meta: { page: Number(url.searchParams.get('page')), pageSize: 20, total: 21, totalPages: 2 } }));
    renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: api });
    const user = userEvent.setup(); await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    await user.selectOptions(screen.getByLabelText('Filter by patient'), p2);
    await user.click(screen.getByRole('button', { name: 'Next report page' }));
    await user.click(await screen.findByRole('button', { name: 'Go to first page' }));
    await screen.findByRole('button', { name: 'Open synthetic.vcf' });
    expect(screen.getByRole('heading', { name: 'Report records' })).toHaveFocus();
    expect(screen.getByLabelText('Filter by patient')).toHaveValue(p2);
    expect(api).toHaveBeenLastCalledWith(`${API}/api/v1/reports?page=1&pageSize=20&patientId=${p2}`, expect.anything());
  });
  it('keeps a download focused while busy, refuses duplicate activation and safely allows retry', async () => {
    let finish: (error: Error) => void = () => {};
    vi.mocked(downloadReport).mockImplementationOnce(() => new Promise((_, reject) => { finish = reject; }));
    renderApp('/reports', { signedInAs: ['reviewer'], fetchImpl: fetcher(['reviewer']) });
    const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    const button = screen.getByRole('button', { name: 'Download synthetic.vcf' });
    await user.click(button); expect(button).toHaveFocus(); expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Verifying download'); await user.click(button);
    expect(downloadReport).toHaveBeenCalledTimes(1);
    finish(new Error('signed-link-and-payload-must-not-render'));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    expect(screen.queryByText('signed-link-and-payload-must-not-render')).not.toBeInTheDocument();
    expect(button).toHaveFocus(); expect(button).toHaveAttribute('aria-disabled', 'false');
    await user.click(button); await waitFor(() => expect(downloadReport).toHaveBeenCalledTimes(2));
    expect(downloadReport).toHaveBeenLastCalledWith(expect.any(Function), row().id, row().filename, row().sizeBytes, row().sha256);
  });
  it('does not offer a download for incomplete uploads, and patient-option failure does not hide reports', async () => {
    const api = fetcher(['clinician'], async () => json({ data: [row(p1, false)], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }));
    const fetchImpl: typeof fetch = async (input, init) => String(input).includes('/patients') ? json({ message: 'private' }, 503) : api(input, init);
    renderApp('/reports', { signedInAs: ['clinician'], fetchImpl });
    const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    expect(screen.queryByRole('button', { name: 'Download synthetic.vcf' })).not.toBeInTheDocument();
    expect(screen.getByText('No — not complete')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to reports' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Reports remain available');
    expect(screen.getByRole('button', { name: 'Open synthetic.vcf' })).toBeInTheDocument();
    expect(downloadReport).not.toHaveBeenCalled();
  });
});

it('opens a separate synthetic preview without passing report or patient context', async () => {
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  try {
    const api = fetcher(['reader']);
    const { router } = renderApp('/reports', { signedInAs: ['reader'], fetchImpl: api });
    await heading();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open synthetic.vcf' }));
    await user.click(await screen.findByText('Example context and tools'));
    const link = await screen.findByRole('link', { name: 'Open full preview' });
    expect(link).toHaveAttribute('href', '/local-interpretation');
    const calls = api.mock.calls.length;
    await user.click(link);
    await screen.findByRole('heading', { name: 'PGx interpretation workspace' });
    expect(router.state.location.search).toBe(''); expect(router.state.location.state).toBeNull();
    expect(screen.queryByText('synthetic.vcf')).not.toBeInTheDocument();
    expect(screen.queryByText('SYN-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(api.mock.calls.length).toBe(calls);
  } finally { vi.unstubAllGlobals(); }
});
