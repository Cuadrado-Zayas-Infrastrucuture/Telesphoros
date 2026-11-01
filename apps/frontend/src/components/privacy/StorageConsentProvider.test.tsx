import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CONSENT_KEY, PREFERENCE_KEYS, preferenceStorage } from '@/lib/storageConsent';
import { setLandingLanguage } from '@/lib/landing/landing-language';
import { StorageConsentProvider } from './StorageConsentProvider';
import { StoragePreferencesButton } from './StoragePreferencesButton';

beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  setLandingLanguage('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
const open = () =>
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <StorageConsentProvider>
        <main id="main" tabIndex={-1}>
          <h1>Storage test</h1>
          <StoragePreferencesButton />
        </main>
      </StorageConsentProvider>
    </MemoryRouter>,
  );

describe('storage consent controls', () => {
  it('rejects optional persistence, removes only its keys and keeps required session state', async () => {
    for (const key of PREFERENCE_KEYS) localStorage.setItem(key, 'synthetic-preference');
    sessionStorage.setItem('oidc.synthetic-state', 'keep');
    localStorage.setItem('unrelated', 'keep');
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Use necessary only' }));
    expect(JSON.parse(localStorage.getItem(CONSENT_KEY)!)).toEqual({ version: 1, preferences: false });
    for (const key of PREFERENCE_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem('oidc.synthetic-state')).toBe('keep');
    expect(localStorage.getItem('unrelated')).toBe('keep');
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('starts optional storage off; Escape discards the draft and restores focus', async () => {
    const { container } = open();
    const manage = screen.getByRole('button', { name: 'Manage' });
    await userEvent.click(manage);
    const dialog = screen.getByRole('dialog', { name: 'Cookies and browser storage' });
    const optional = within(dialog).getByRole('checkbox', { name: 'Remember display and language settings' });
    expect(optional).not.toBeChecked();
    await userEvent.click(optional);
    expect(optional).toBeChecked();
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(manage).toHaveFocus();
    expect(localStorage.getItem(CONSENT_KEY)).toBeNull();
    await userEvent.click(manage);
    expect(within(screen.getByRole('dialog')).getByRole('checkbox')).not.toBeChecked();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reopens a saved choice and withdraws optional persistence without clearing unrelated storage', async () => {
    preferenceStorage.choose(true);
    preferenceStorage.write('telesphoros.theme', 'dark');
    preferenceStorage.write('telesphoros.sidebar', 'collapsed');
    localStorage.setItem('unrelated', 'keep');
    open();
    const reopen = screen.getByRole('button', { name: 'Cookie settings' });
    await userEvent.click(reopen);
    const dialog = screen.getByRole('dialog');
    const optional = within(dialog).getByRole('checkbox');
    expect(optional).toBeChecked();
    await userEvent.click(optional);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save choices' }));
    expect(preferenceStorage.getSnapshot().preferences).toBe(false);
    expect(localStorage.getItem('telesphoros.theme')).toBeNull();
    expect(localStorage.getItem('telesphoros.sidebar')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(reopen).toHaveFocus();
  });

  it('reports a blocked save/clear and still applies the explicit choice to this tab', async () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const)
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Use necessary only' }));
    expect(screen.getByRole('alert')).toHaveTextContent('prevented clearing saved preferences');
    expect(preferenceStorage.getSnapshot()).toEqual({ preferences: false, persisted: false });
    await userEvent.click(screen.getByRole('button', { name: 'Close cookie settings' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });
});
