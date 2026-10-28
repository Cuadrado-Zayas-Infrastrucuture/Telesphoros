import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient, RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const EMAIL = 'alice@example.test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** An API that answers sign-in, and `/me/profile` with each of the given answers in turn (the last one repeats). */
function api(roles: Role[], ...profile: Array<() => Response>) {
  let call = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/me') return json({ roles });
    if (path === '/api/v1/me/recovery-scope') return json({ recoveryScope: RECOVERY_SCOPE });
    if (path === '/api/v1/me/profile') return profile[Math.min(call++, profile.length - 1)]!();
    return json({}, 404);
  });
}
const organization = () => json({ organization: { name: 'Synthetic Clinic Alpha' } });

/** `email: null` signs in with an ID token that carried no email claim. */
function open(roles: Role[], fetchImpl: ReturnType<typeof api>, email: string | null = EMAIL) {
  return renderApp('/settings', { signedInAs: roles, client: fakeClient({ returnTo: '/settings', ...(email ? { email } : {}) }), fetchImpl: fetchImpl as unknown as typeof fetch });
}
const section = async (name: string) => screen.findByRole('region', { name });

describe('Settings', () => {
  it('shows who is signed in, their organization and what their roles allow', async () => {
    open(['clinician', 'reviewer'], api(['clinician', 'reviewer'], organization));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const account = await section('Account');
    expect(within(account).getByText(EMAIL)).toBeInTheDocument();
    expect(await within(account).findByText('Synthetic Clinic Alpha')).toBeInTheDocument();
    const roles = await section('Roles');
    expect(within(roles).getByText('Clinician')).toBeInTheDocument();
    expect(within(roles).getByText('Reviewer')).toBeInTheDocument();
    expect(within(roles).queryByText('Administrator')).not.toBeInTheDocument();
  });

  it('never sends the email to the API, in any address, header or body', async () => {
    const fetchImpl = api(['reader'], organization);
    open(['reader'], fetchImpl);
    await within(await section('Account')).findByText('Synthetic Clinic Alpha');
    expect(fetchImpl).toHaveBeenCalled();
    for (const [input, init] of fetchImpl.mock.calls) expect(JSON.stringify([String(input), init ?? {}])).not.toContain(EMAIL);
  });

  it('is open to a member with no role, and says what that means', async () => {
    open([], api([], organization));
    const roles = await section('Roles');
    expect(within(roles).getByText(/without a role yet/)).toBeInTheDocument();
    expect(within(await section('Account')).getByText(EMAIL)).toBeInTheDocument();
  });

  it('says the organization is not available when an older server answers 404, and that is not an error', async () => {
    open(
      ['reader'],
      api(['reader'], () => json({}, 404)),
    );
    const account = await section('Account');
    expect(await within(account).findByText('Not available on this server yet.')).toBeInTheDocument();
    expect(within(account).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a failed load and loads again on Retry', async () => {
    open(
      ['reader'],
      api(['reader'], () => json({}, 500), organization),
    );
    const account = await section('Account');
    expect(await within(account).findByRole('alert')).toHaveTextContent('The organization could not be loaded. Please retry.');
    await userEvent.click(within(account).getByRole('button', { name: 'Retry' }));
    expect(await within(account).findByText('Synthetic Clinic Alpha')).toBeInTheDocument();
  });

  it('refuses a reply that does not match the profile contract', async () => {
    open(
      ['reader'],
      api(['reader'], () => json({ organization: { name: 'Synthetic Clinic Alpha' }, email: EMAIL })),
    );
    expect(await within(await section('Account')).findByRole('alert')).toBeInTheDocument();
  });

  it('says so when the sign-in provider shared no email', async () => {
    open(['reader'], api(['reader'], organization), null);
    expect(await within(await section('Account')).findByText('Your sign-in provider did not share an email address.')).toBeInTheDocument();
  });

  it('signs out from the Session section', async () => {
    const { client } = open(['reader'], api(['reader'], organization));
    await userEvent.click(within(await section('Session and privacy')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(client.signOut).toHaveBeenCalledTimes(1));
  });

  it('is linked from the navigation once signed in', async () => {
    open([], api([], organization));
    await section('Account');
    expect(screen.getAllByRole('link', { name: /Settings/ }).length).toBeGreaterThan(0);
  });

  it('sends a signed-out visitor to the sign-in page, to come back here, without showing anything', async () => {
    const { router } = renderApp('/settings');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(router.state.location.state).toEqual({ returnTo: '/settings' });
    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();
  });
});
