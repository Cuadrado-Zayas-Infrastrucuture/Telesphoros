import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { renderApp } from '@/test/authTestUtils';

it('offers one sign-in action and no overview detour when entering the protected workspace', async () => {
  const { client, router } = renderApp('/workspace');
  await screen.findByRole('heading', { name: 'Sign in' });
  const header = screen.getByRole('banner');
  expect(within(header).queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
  expect(within(header).queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  expect(within(header).queryByRole('navigation')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Sign in' });
  await userEvent.click(button);
  expect(client.signIn).toHaveBeenCalledWith('/workspace');
  expect(router.state.location.pathname).toBe('/signin');
});
