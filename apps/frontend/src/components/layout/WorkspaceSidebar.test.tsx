import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/authTestUtils';

const sidebar = () => document.querySelector<HTMLElement>('header.workspace-navigation');
/** The sidebar's navigation, once sign-in has finished (before that, the signed-out header has its own "Primary" navigation). */
const primary = async () => {
  await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
  return within(screen.getByRole('navigation', { name: 'Primary' }));
};
const linkNames = async () => (await primary()).getAllByRole('link').map((link) => link.textContent);

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('one sidebar for every signed-in page (specs/018-unified-sidebar)', () => {
  it('frames Settings with the sidebar, holding Reports and Upload together for a clinician', async () => {
    renderApp('/settings', { signedInAs: ['clinician'] });
    expect(await linkNames()).toEqual(['Reports', 'Upload report', 'Settings', 'Overview']);
    expect(sidebar()).not.toBeNull();
  });

  it('in the local preview, puts "Workspace" first, linking to the one-screen workspace (specs/022)', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: '127.0.0.1' });
    try {
      renderApp('/settings', { signedInAs: ['clinician'] });
      const nav = await primary();
      expect(nav.getAllByRole('link').map((link) => link.textContent)).toEqual(['Workspace', 'Chat preview', 'Reports', 'Upload report', 'Settings', 'Overview']);
      expect(nav.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/local-workspace');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives an administrator Usage and no Reports link that would lead to "no access"', async () => {
    renderApp('/usage', { signedInAs: ['admin'] as Role[] });
    expect(await linkNames()).toEqual(['Usage', 'Settings', 'Overview']);
  });

  it('keeps the site header on the public landing page, even when signed in', async () => {
    renderApp('/', { signedInAs: ['clinician'] });
    await screen.findByRole('main');
    expect(sidebar()).toBeNull();
  });

  it('collapses to icons and back, keeps every link name for assistive technology, and remembers the choice', async () => {
    const { unmount } = renderApp('/settings', { signedInAs: ['clinician'] });
    await primary();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(sidebar()).toHaveClass('is-collapsed');
    expect(window.localStorage.getItem('telesphoros.sidebar')).toBe('collapsed');
    const settings = (await primary()).getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('title', 'Settings');
    // CSS shows one of the two Sign out controls (jsdom applies no CSS; the browser suite checks which is visible).
    expect(document.querySelector('.workspace-account-compact')).toHaveAccessibleName('Sign out');
    unmount();

    renderApp('/settings', { signedInAs: ['clinician'] });
    await primary();
    expect(sidebar()).toHaveClass('is-collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(sidebar()).not.toHaveClass('is-collapsed');
    expect(window.localStorage.getItem('telesphoros.sidebar')).toBeNull();
  });

  it('starts expanded, and still collapses, when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderApp('/settings', { signedInAs: ['reader'] });
    await primary();
    expect(sidebar()).not.toHaveClass('is-collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(sidebar()).toHaveClass('is-collapsed');
  });
});
