import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe('routes', () => {
  it.each([
    ['/', 'Pharmacogenomic decision support at the point of care'],
    ['/reports/upload', 'Upload report'],
    ['/nope', 'Page not found'],
  ])('lazy-loads %s and exposes one h1', async (path, heading) => {
    const { container } = renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('gives every informative image a non-empty alt text', async () => {
    renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    for (const img of screen.getAllByRole('img')) {
      expect(img.getAttribute('alt')?.trim()).toBeTruthy();
    }
  });

  it('makes the skip link the first tab stop and the nav keyboard-reachable', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole('link', { name: /Telesphoros/ })[0]).toHaveFocus();
  });

  it('navigates between pages with real links and moves focus to the main region', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    await user.click(screen.getByRole('link', { name: 'Upload report' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Upload report' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
  });
});
