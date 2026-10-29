import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { AuthProvider } from '@/auth/AuthProvider';
import { API, fakeClient, fakeFetch, renderApp } from '@/test/authTestUtils';

const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('public pages', () => {
  it.each([
    ['/', 'A clearer view of your PGx reports.'],
    ['/signin', 'Sign in'],
    ['/signed-out', 'You have been signed out'],
    ['/nope', 'Page not found'],
  ])('lazy-loads %s with exactly one h1, no accessibility violations, and no sign-in needed', async (path, title) => {
    const { container } = renderApp(path);
    expect(await heading(title)).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('gives every informative image a non-empty alt text', async () => {
    renderApp('/');
    await heading(/A clearer view of/);
    for (const img of screen.getAllByRole('img')) expect(img.getAttribute('alt')?.trim()).toBeTruthy();
  });

  it('makes the skip link the first tab stop', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await heading(/A clearer view of/);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });
});

describe('protected pages', () => {
  it('send an anonymous visitor to sign in, and remember where they were going', async () => {
    const { client } = renderApp('/reports/upload');
    expect(await heading('Sign in')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(client.signIn).toHaveBeenCalledWith('/reports/upload');
  });

  it('let a clinician in, and show them the upload form', async () => {
    renderApp('/reports/upload', { signedInAs: ['clinician'] });
    expect(await heading('Upload report')).toBeInTheDocument();
    expect(screen.getByLabelText(/report file/i)).toBeInTheDocument();
  });

  it('let an administrator in only if they also hold a clinical role', async () => {
    renderApp('/reports/upload', { signedInAs: ['admin', 'clinician'] });
    expect(await heading('Upload report')).toBeInTheDocument();
  });

  it('tell an administrator alone that administration is not clinical access', async () => {
    renderApp('/reports/upload', { signedInAs: ['admin'] });
    expect(await heading('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByLabelText(/report file/i)).not.toBeInTheDocument();
  });

  it.each([
    ['a reader', ['reader'] as const],
    ['a user with no role', [] as const],
  ])('tell %s politely that they lack access, instead of the form', async (_who, roles) => {
    const { container } = renderApp('/reports/upload', { signedInAs: [...roles] });
    expect(await heading('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByLabelText(/report file/i)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('hide the upload link from people who cannot use it', async () => {
    renderApp('/settings', { signedInAs: ['reader'] });
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(screen.queryByRole('link', { name: 'Upload report' })).not.toBeInTheDocument();
  });

  it('show the upload link, the role and a sign-out control in the sidebar to a clinician', async () => {
    renderApp('/settings', { signedInAs: ['clinician'] });
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(screen.getByRole('link', { name: 'Upload report' })).toBeInTheDocument();
    const sidebar = document.querySelector('header.workspace-navigation') as HTMLElement;
    expect(within(sidebar).getByText('clinician')).toBeInTheDocument();
    expect(within(sidebar).getAllByRole('button', { name: 'Sign out' })[0]).toBeEnabled();
  });

  it('offer the way back into the workspace on the landing header, with no sign-out there', async () => {
    renderApp('/', { signedInAs: ['clinician'] });
    expect(await screen.findByRole('link', { name: 'Open workspace' })).toHaveAttribute('href', '/reports');
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('sign out calls the identity client and forgets the user', async () => {
    const { client } = renderApp('/settings', { signedInAs: ['clinician'] });
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const sidebar = document.querySelector('header.workspace-navigation') as HTMLElement;
    await userEvent.setup().click(within(sidebar).getAllByRole('button', { name: 'Sign out' })[0]!);
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upload report' })).not.toBeInTheDocument();
  });
});

describe('the sign-in callback', () => {
  it('sends the user on to where they were going, replacing the callback URL in the history', async () => {
    const { router } = renderApp('/reports/upload', { signedInAs: ['clinician'] });
    await heading('Upload report');
    expect(router.state.location.pathname).toBe('/reports/upload');
    // `replace`: going back must not return to the one-time-code URL.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('shows a clear failure, with a way to try again, when the code cannot be redeemed', async () => {
    const client = fakeClient();
    client.completeSignIn.mockRejectedValue(new Error('invalid_grant'));
    const router = createMemoryRouter(routes, { initialEntries: ['/auth/callback'] });
    const { container } = render(
      <AuthProvider client={client} apiBaseUrl={API} fetchImpl={fakeFetch() as unknown as typeof fetch}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
    expect(await heading('Sign-in did not complete')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/signin');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('does not loop when the API rejects a fresh token: it stops with a message and never starts another sign-in', async () => {
    const { client } = renderApp('/reports/upload', {
      signedInAs: ['clinician'],
      fetchImpl: fakeFetch({ status: 401 }) as unknown as typeof fetch,
    });
    expect(await heading('Sign-in did not complete')).toBeInTheDocument();
    await waitFor(() => expect(client.signIn).not.toHaveBeenCalled());
  });
});
