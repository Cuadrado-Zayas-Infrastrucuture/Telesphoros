import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from '@/test/authTestUtils';

afterEach(() => vi.unstubAllEnvs());
it.each([{ roles: ['reader'] }, { roles: ['reviewer'] }, { roles: [] }] as const)('does not give landing upload actions to $roles', async ({ roles }) => {
  renderApp('/', { signedInAs: [...roles] });
  await screen.findByRole('heading', { name: /A clearer view of/ });
  expect(screen.queryByRole('link', { name: /Upload/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Explore the workflow/ })).toHaveLength(2);
});
it.each(['clinician', 'admin'] as const)('keeps existing upload destination for %s', async role => {
  renderApp('/', { signedInAs: [role] });
  await screen.findByRole('heading', { name: /A clearer view of/ });
  for (const link of screen.getAllByRole('link', { name: 'Upload a synthetic report' })) expect(link).toHaveAttribute('href', '/reports/upload');
});
it('preserves the owned-storage home and avoids marketing in that workflow', async () => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  renderApp('/', { signedInAs: ['reader'] });
  await screen.findByRole('heading', { name: 'Synthetic report storage' });
  expect(screen.getByRole('link', { name: 'View reports' })).toHaveAttribute('href', '/reports');
  expect(screen.queryByRole('heading', { name: /A clearer view of/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Workspace' })).not.toBeInTheDocument();
});
