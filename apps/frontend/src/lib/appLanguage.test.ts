import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { preferenceStorage } from '@/lib/storageConsent';
import { APP_LANGUAGE_KEY, setAppLanguage, storedAppLanguage, useAppLanguage } from './appLanguage';

// Spec 050 LS1: the app's language is English unless chosen (R1), under its own key, kept only with consent, and for the session without it (R2).

afterEach(() => {
  act(() => setAppLanguage('en'));
  localStorage.clear();
  // The own properties set below shadow jsdom's getters; removing them restores those.
  delete (window.navigator as { language?: string }).language;
  delete (window.navigator as { languages?: readonly string[] }).languages;
});

describe('the app language', () => {
  it('is English with no choice, even in a Spanish browser (R1)', () => {
    Object.defineProperty(window.navigator, 'language', { value: 'es-PR', configurable: true });
    Object.defineProperty(window.navigator, 'languages', { value: ['es-PR', 'es'], configurable: true });
    expect(navigator.language).toBe('es-PR');
    preferenceStorage.choose(true);
    expect(storedAppLanguage()).toBe('en');
    const { result } = renderHook(() => useAppLanguage());
    expect(result.current.language).toBe('en');
  });

  it('control: a saved Spanish choice, with consent, is read back', () => {
    preferenceStorage.choose(true);
    localStorage.setItem(APP_LANGUAGE_KEY, 'es');
    expect(storedAppLanguage()).toBe('es');
  });

  it('without consent, a choice lasts for the session and is not saved (R2)', () => {
    preferenceStorage.choose(false);
    const { result } = renderHook(() => useAppLanguage());
    act(() => result.current.setLanguage('es'));
    expect(result.current.language).toBe('es');
    expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBeNull();
  });

  it('with consent, a choice is saved under its own key, apart from the landing language', () => {
    preferenceStorage.choose(true);
    const { result } = renderHook(() => useAppLanguage());
    act(() => result.current.setLanguage('es'));
    expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBe('es');
    expect(localStorage.getItem('telesphoros.landing.language')).toBeNull();
  });

  it('withdrawing consent removes the saved choice', () => {
    preferenceStorage.choose(true);
    act(() => setAppLanguage('es'));
    expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBe('es');
    act(() => {
      preferenceStorage.choose(false);
    });
    expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBeNull();
  });
});
