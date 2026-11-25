import { useSyncExternalStore } from 'react';
import { preferenceStorage } from '@/lib/storageConsent';

/*
 * The signed-in app's language (spec 050, slice LS1). English unless the person chooses Spanish, whatever the browser's language (R1). The choice is
 * kept under its own key, only with consent, and lasts for the session without storage (R2), as the landing's does (`landing/landing-language.ts`).
 * It is separate from the landing's, so a visitor's choice on the public page never switches a clinical screen.
 *
 * Nothing in the app offers the choice yet: the account menu keeps "Español: aún no disponible" until slice LS6 (LS-D2), so only tests call
 * `setAppLanguage`. A Spanish choice reaches a screen only when that screen is translated (`words/screens.ts`).
 */
export type AppLanguage = 'en' | 'es';

export const APP_LANGUAGE_KEY = 'telesphoros.app.language';
const listeners = new Set<() => void>();

/** The saved choice, or English. The browser's language is never read (R1). */
export function storedAppLanguage(): AppLanguage {
  try {
    return preferenceStorage.read(APP_LANGUAGE_KEY) === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}
let current: AppLanguage = typeof window === 'undefined' ? 'en' : storedAppLanguage();

export function setAppLanguage(language: AppLanguage) {
  current = language;
  try {
    preferenceStorage.write(APP_LANGUAGE_KEY, language);
  } catch {
    /* the choice still applies for this session */
  }
  listeners.forEach((listener) => listener());
}

// A consent change can make a saved language available, or withdraw it.
preferenceStorage.subscribe(() => {
  current = storedAppLanguage();
  listeners.forEach((listener) => listener());
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useAppLanguage() {
  const language = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'en' as AppLanguage,
  );
  return { language, setLanguage: setAppLanguage };
}
