import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role, UsageDto } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const USAGE: UsageDto = {
  timeZone: 'America/Puerto_Rico',
  months: [
    { month: '2026-10', reportsUploaded: 1234, evaluations: { evaluated: 56, held: 7 } },
    { month: '2026-09', reportsUploaded: 89, evaluations: { evaluated: 10, held: 0 } },
  ],
  storage: { reportFiles: 1300, reportBytes: 2_500_000_000 },
};

/** An API that answers sign-in, and `/usage` with each of the given answers in turn (the last one repeats). */
function api(roles: Role[], ...usage: Array<() => Response>) {
  let call = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/me') return json({ roles });
    if (path === '/api/v1/me/recovery-scope') return json({ recoveryScope: RECOVERY_SCOPE });
    if (path === '/api/v1/me/profile') return json({ organization: { name: 'Synthetic Clinic Alpha' } });
    if (path === '/api/v1/usage') return usage[Math.min(call++, usage.length - 1)]!();
    return json({}, 404);
  });
}
const open = (path: string, roles: Role[], fetchImpl: ReturnType<typeof api>) => renderApp(path, { signedInAs: roles, fetchImpl: fetchImpl as unknown as typeof fetch });
const usageCalls = (fetchImpl: ReturnType<typeof api>) => fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/v1/usage').length;

describe('Usage', () => {
  it('shows an administrator this month so far, last month and storage, named and formatted', async () => {
    open(
      '/usage',
      ['admin'],
      api(['admin'], () => json(USAGE)),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeInTheDocument();
    const current = await screen.findByRole('region', { name: 'October 2026, so far' });
    expect(within(current).getByText('1,234')).toBeInTheDocument();
    expect(within(current).getByText('56')).toBeInTheDocument();
    expect(within(current).getByText('7')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'September 2026' })).getByText('89')).toBeInTheDocument();
    const storage = screen.getByRole('region', { name: 'Storage' });
    expect(within(storage).getByText('1,300')).toBeInTheDocument();
    expect(within(storage).getByText('2.5 GB')).toBeInTheDocument();
  });

  it('says so and offers a Retry that works when loading fails', async () => {
    const fetchImpl = api(
      ['admin'],
      () => json({}, 500),
      () => json(USAGE),
    );
    open('/usage', ['admin'], fetchImpl);
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage could not be loaded');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Storage' })).toBeInTheDocument();
    expect(usageCalls(fetchImpl)).toBe(2);
  });

  it('treats a reply that breaks the contract as a failure', async () => {
    open(
      '/usage',
      ['admin'],
      api(['admin'], () => json({ ...USAGE, storage: { reportFiles: -1, reportBytes: 0 } })),
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument();
  });

  it('says usage is not available when an older server answers 404, and that is not an error', async () => {
    open(
      '/usage',
      ['admin'],
      api(['admin'], () => json({}, 404)),
    );
    expect(await screen.findByText('Usage is not available on this server yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is offered to an administrator from the navigation and from Settings', async () => {
    open(
      '/settings',
      ['admin'],
      api(['admin'], () => json(USAGE)),
    );
    const administration = await screen.findByRole('region', { name: 'Administration' });
    expect(within(administration).getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/usage');
    expect(screen.getAllByRole('link', { name: /^Usage$/ }).length).toBeGreaterThan(0);
  });

  it('is neither shown nor loaded for any other role, or for a member with no role', async () => {
    for (const roles of [['clinician'], ['reader'], ['reviewer'], []] as Role[][]) {
      const fetchImpl = api(roles, () => json(USAGE));
      const { unmount } = open('/usage', roles, fetchImpl);
      expect(await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^Usage$/ })).not.toBeInTheDocument();
      await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
      expect([roles, usageCalls(fetchImpl)]).toEqual([roles, 0]);
      unmount();
    }
  });

  it('announces loading once, and holds the page layout with placeholder cards until the figures arrive', async () => {
    open(
      '/usage',
      ['admin'],
      api(['admin'], () => new Promise<Response>(() => {}) as unknown as Response),
    );
    expect(await screen.findByText('Loading usage…')).toHaveAttribute('role', 'status');
    const summary = document.getElementById('usage-storage')!.closest('section')!.parentElement!;
    expect(summary).toHaveAttribute('aria-hidden', 'true');
    expect(summary.querySelectorAll('dl > div')).toHaveLength(8);
    expect(summary.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(8);
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument();
  });
});
