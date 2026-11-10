import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderApp, renderSignedInAt } from '@/test/authTestUtils';
import { goToPublicSite, isStagingApp, usesPublicLanding } from '@/lib/landing/public-site';

vi.mock('@/lib/landing/public-site', () => ({ usesPublicLanding: vi.fn(), isStagingApp: vi.fn(), goToPublicSite: vi.fn() }));

beforeEach(() => {
  vi.mocked(usesPublicLanding).mockReturnValue(true);
  vi.mocked(isStagingApp).mockReturnValue(false);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it('sends a signed-out visitor on the production app to the public landing page', async () => {
  renderApp('/');
  await waitFor(() => expect(goToPublicSite).toHaveBeenCalled());
  expect(screen.queryByRole('heading', { name: /PGx reports, interpreted/ })).not.toBeInTheDocument();
});

it('sends a signed-out visitor on the staging app to its own sign-in page, never to the live site', async () => {
  vi.mocked(isStagingApp).mockReturnValue(true);
  const { router } = renderApp('/');
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(goToPublicSite).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: /PGx reports, interpreted/ })).not.toBeInTheDocument();
});

it.each([
  { role: 'clinician', home: '/workspace' },
  { role: 'admin', home: '/usage' },
] as const)('keeps a signed-in $role in the app, at their own home', async ({ role, home }) => {
  const { router } = await renderSignedInAt('/', { signedInAs: [role] });
  await waitFor(() => expect(router.state.location.pathname).toBe(home));
  expect(goToPublicSite).not.toHaveBeenCalled();
});

it.each(['/signin', '/signed-out'])('does not take a visitor away from %s', async (path) => {
  const { router } = renderApp(path);
  await waitFor(() => expect(router.state.location.pathname).toBe(path));
  await screen.findAllByRole('heading');
  expect(goToPublicSite).not.toHaveBeenCalled();
});

it('keeps the in-app landing on a host that is not the deployed app', async () => {
  vi.mocked(usesPublicLanding).mockReturnValue(false);
  renderApp('/');
  await screen.findByRole('heading', { name: /PGx reports, interpreted/ });
  expect(goToPublicSite).not.toHaveBeenCalled();
});

it('keeps the owned-storage home in that local build', async () => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  renderApp('/');
  await screen.findByRole('heading', { name: 'Synthetic report storage' });
  expect(goToPublicSite).not.toHaveBeenCalled();
});
