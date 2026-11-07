import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsageDaysDto, UsageDto } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const USAGE: UsageDto = {
  timeZone: 'America/Puerto_Rico',
  months: [
    { month: '2026-10', reportsUploaded: 12, evaluations: { evaluated: 5, held: 1 } },
    { month: '2026-09', reportsUploaded: 8, evaluations: { evaluated: 3, held: 0 } },
  ],
  storage: { reportFiles: 20, reportBytes: 2_000_000 },
};
const DAYS_2026: UsageDaysDto = {
  timeZone: 'America/Puerto_Rico',
  year: 2026,
  firstDate: '2025-03-09',
  today: '2026-10-31',
  days: [
    { date: '2026-05-14', reportsUploaded: 9 },
    { date: '2026-05-15', reportsUploaded: 2 },
    { date: '2026-10-31', reportsUploaded: 1 },
  ],
};
const DAYS_2025: UsageDaysDto = { ...DAYS_2026, year: 2025, days: [{ date: '2025-12-24', reportsUploaded: 4 }] };

/** An API that answers sign-in, `/usage`, and `/usage/days` with each of the given answers in turn (the last one repeats). */
function api(...days: Array<(url: URL) => Response | Promise<Response>>) {
  let call = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/me') return json({ roles: ['admin'] });
    if (url.pathname === '/api/v1/me/recovery-scope') return json({ recoveryScope: RECOVERY_SCOPE });
    if (url.pathname === '/api/v1/me/profile') return json({ organization: { name: 'Synthetic Clinic Alpha' } });
    if (url.pathname === '/api/v1/usage') return json(USAGE);
    if (url.pathname === '/api/v1/usage/days') return days[Math.min(call++, days.length - 1)]!(url);
    return json({}, 404);
  });
}
const open = (fetchImpl: ReturnType<typeof api>) => renderApp('/usage', { signedInAs: ['admin'], fetchImpl: fetchImpl as unknown as typeof fetch });
const dayCalls = (fetchImpl: ReturnType<typeof api>) =>
  fetchImpl.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/api/v1/usage/days')
    .map((url) => url.search);
const calendar = () => screen.findByRole('region', { name: 'Reports uploaded per day' });

describe('Usage calendar (specs/028-usage-heatmap)', () => {
  it('shows this year: a summary, each day named for assistive technology, and the month table that totals the days', async () => {
    open(api(() => json(DAYS_2026)));
    const region = await calendar();
    expect(await within(region).findByText('2026: 12 reports uploaded. Busiest day: Thursday, 14 May 2026, with 9 reports uploaded.')).toBeInTheDocument();
    const grid = within(region).getByRole('grid');
    expect(within(grid).getByRole('gridcell', { name: 'Thursday, 14 May 2026: 9 reports uploaded' })).toHaveAttribute('data-kind', 'counted');
    expect(within(grid).getByRole('gridcell', { name: 'Saturday, 31 October 2026: 1 report uploaded' })).toBeInTheDocument();
    expect(within(grid).getByRole('gridcell', { name: 'Sunday, 1 November 2026: not counted' })).toHaveAttribute('data-kind', 'not-counted');
    expect(within(grid).getByRole('gridcell', { name: 'Friday, 2 January 2026: no reports uploaded' })).toHaveAttribute('data-kind', 'zero');
    const table = within(region).getByRole('table', { name: 'Reports uploaded per month, 2026' });
    expect(within(within(table).getByRole('row', { name: /^May/ })).getByText('11')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /^October/ })).getByText('1')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /^November/ })).getByText('Not counted')).toBeInTheDocument();
  });

  it('loads another year from the picker, keeps the monthly figures, and asks for nothing else again', async () => {
    const fetchImpl = api(
      () => json(DAYS_2026),
      () => json(DAYS_2025),
    );
    open(fetchImpl);
    const region = await calendar();
    const picker = await within(region).findByRole('combobox', { name: 'Year' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['2026', '2025']);
    await userEvent.selectOptions(picker, '2025');
    expect(await within(region).findByText('2025: 4 reports uploaded. Busiest day: Wednesday, 24 December 2025, with 4 reports uploaded.')).toBeInTheDocument();
    expect(dayCalls(fetchImpl)).toEqual(['', '?year=2025']);
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/v1/usage')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Storage' })).toBeInTheDocument();
  });

  it('offers no picker when the organization has only this year', async () => {
    open(api(() => json({ ...DAYS_2026, firstDate: '2026-10-01' })));
    const region = await calendar();
    await within(region).findByRole('grid');
    expect(within(region).queryByRole('combobox', { name: 'Year' })).not.toBeInTheDocument();
  });

  it('moves through days with the arrow keys from one tab stop, and says what each holds', async () => {
    open(api(() => json(DAYS_2026)));
    const region = await calendar();
    const grid = await within(region).findByRole('grid');
    const stops = within(grid)
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute('data-date', '2026-10-31'); // today
    stops[0]!.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-10-24');
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toHaveAttribute('data-date', '2026-10-23');
    expect(within(region).getByText('Friday, 23 October 2026: no reports uploaded', { selector: '#usage-calendar-readout' })).toBeInTheDocument();
  });

  it('fails on its own with a Retry that works, leaving the monthly figures in place', async () => {
    const fetchImpl = api(
      () => json({}, 500),
      () => json(DAYS_2026),
    );
    open(fetchImpl);
    const region = await calendar();
    expect(await within(region).findByRole('alert')).toHaveTextContent('The calendar could not be loaded');
    expect(screen.getByRole('region', { name: 'Storage' })).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await within(region).findByRole('grid')).toBeInTheDocument();
    expect(dayCalls(fetchImpl)).toEqual(['', '']);
  });

  it('treats a reply that breaks the contract as a failure', async () => {
    open(api(() => json({ ...DAYS_2026, days: [{ date: '2026-05-14', reportsUploaded: 0 }] })));
    expect(await within(await calendar()).findByRole('alert')).toBeInTheDocument();
  });

  it('says the calendar is not available when an older server answers 404, and that is not an error', async () => {
    open(api(() => json({}, 404)));
    const region = await calendar();
    expect(await within(region).findByText('The calendar is not available on this server yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Storage' })).toBeInTheDocument();
  });

  it('announces its loading, and has no axe violations once loaded', async () => {
    let answer: ((response: Response) => void) | undefined;
    const { container } = open(api(() => new Promise<Response>((resolve) => (answer = resolve))));
    expect(await screen.findByText('Loading the calendar…')).toHaveAttribute('role', 'status');
    // The table-shaped placeholder: summary, grid block, the month table's header (two bars) and four rows (two bars each).
    expect((await calendar()).querySelectorAll('[data-slot="skeleton"]')).toHaveLength(12);
    await waitFor(() => expect(answer).toBeDefined());
    answer!(json(DAYS_2026));
    await within(await calendar()).findByRole('grid');
    expect(await axe(container)).toHaveNoViolations();
  });
});
