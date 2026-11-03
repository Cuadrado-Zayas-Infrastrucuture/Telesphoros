import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { expect, it } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import { fakeClient } from '@/test/authTestUtils';
import { AppLayout } from './AppLayout';

it('shows a skeleton during lazy navigation and preserves a draft when navigation is cancelled', async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const router = createMemoryRouter([
    {
      element: (
        <AuthProvider client={fakeClient()} apiBaseUrl="http://api.test">
          <AppLayout />
        </AuthProvider>
      ),
      children: [
        {
          path: '/',
          element: (
            <>
              <label>
                Draft
                <input />
              </label>
              <Link to="/next">Next page</Link>
            </>
          ),
        },
        {
          path: '/next',
          lazy: async () => {
            await ready;
            return { Component: () => <h1>Next page ready</h1> };
          },
        },
      ],
    },
  ]);
  const { container } = render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Draft' }), 'Synthetic draft');
  await user.click(screen.getByRole('link', { name: 'Next page' }));
  expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByText('Loading page…')).toBeInTheDocument();
  expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Synthetic draft');
  await act(async () => {
    await router.navigate('/');
  });
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Synthetic draft');
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
  await act(async () => {
    finish();
    await ready;
  });
  expect(screen.queryByRole('heading', { name: 'Next page ready' })).not.toBeInTheDocument();
});
