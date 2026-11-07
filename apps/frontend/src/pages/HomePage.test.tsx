import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderSignedInAt } from '@/test/authTestUtils';
import { signedInHome } from '@/lib/localWorkspace';

afterEach(() => vi.unstubAllEnvs());
it.each([{ roles: ['reader'] }, { roles: ['reviewer'] }, { roles: ['admin'] }, { roles: [] }] as const)('does not give landing upload actions to $roles', async ({ roles }) => {
  await renderSignedInAt('/', { signedInAs: [...roles] });
  await screen.findByRole('heading', { name: /PGx reports, interpreted/ });
  expect(screen.queryByRole('link', { name: /Upload/ })).not.toBeInTheDocument();
  // The header's account control and the hero both lead to the signed-in home.
  for (const link of screen.getAllByRole('link', { name: 'Open workspace' })) expect(link).toHaveAttribute('href', signedInHome([...roles]));
  expect(screen.getAllByRole('link', { name: 'Open workspace' })).toHaveLength(2);
});
it.each(['clinician'] as const)('sends the upload action to the signed-in home, where reports are attached, for %s', async (role) => {
  await renderSignedInAt('/', { signedInAs: [role] });
  await screen.findByRole('heading', { name: /PGx reports, interpreted/ });
  for (const link of screen.getAllByRole('link', { name: 'Upload a synthetic report' })) expect(link).toHaveAttribute('href', signedInHome([role]));
  expect(screen.getAllByRole('link', { name: 'Upload a synthetic report' })).toHaveLength(1);
});
it.each([{ roles: ['admin'] }, { roles: [] }] as const)('shows no Reports link in the header to $roles, who cannot open the page', async ({ roles }) => {
  await renderSignedInAt('/', { signedInAs: [...roles] });
  await screen.findByRole('heading', { name: /PGx reports, interpreted/ });
  expect(screen.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
});
it.each(['reader', 'reviewer', 'clinician'] as const)('shows the Reports link in the header to %s', async (role) => {
  await renderSignedInAt('/', { signedInAs: [role] });
  await screen.findByRole('heading', { name: /PGx reports, interpreted/ });
  expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
});
it('preserves the owned-storage home and avoids marketing in that workflow', async () => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  await renderSignedInAt('/', { signedInAs: ['reader'] });
  await screen.findByRole('heading', { name: 'Synthetic report storage' });
  expect(screen.getByRole('link', { name: 'View reports' })).toHaveAttribute('href', '/reports');
  expect(screen.queryByRole('heading', { name: /PGx reports, interpreted/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Workspace' })).not.toBeInTheDocument();
});
