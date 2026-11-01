import { preferenceStorage } from '@/lib/storageConsent';
import { useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { ownedStorageMode } from '@/lib/storageMode';
import { LANDING_COPY, type LandingLanguage } from './landing-copy';

/*
 * The landing's language: English unless the visitor picks Spanish, whatever the browser's language. The choice is kept
 * in localStorage when it is available; without storage (private window, blocked site data) it lasts for the session.
 * It reaches the landing's header and footer too, so the whole page changes together. Nothing outside the landing reads it.
 */
const KEY = 'telesphoros.landing.language';
const listeners = new Set<() => void>();

function stored(): LandingLanguage {
  try {
    return preferenceStorage.read(KEY) === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}
let current: LandingLanguage = typeof window === 'undefined' ? 'en' : stored();

export function setLandingLanguage(language: LandingLanguage) {
  current = language;
  try {
    preferenceStorage.write(KEY, language);
  } catch {
    /* the choice still applies for this session */
  }
  listeners.forEach((listener) => listener());
}

// Consent changes may make a saved language available; session choices still take precedence.
preferenceStorage.subscribe(() => {
  current = stored();
  listeners.forEach((listener) => listener());
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useLandingLanguage() {
  const language = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'en' as LandingLanguage,
  );
  return { language, copy: LANDING_COPY[language], setLanguage: setLandingLanguage };
}

/** True on the product landing only; the signed-in storage workspace and every other page stay English. */
export function useLandingRoute() {
  return useLocation().pathname === '/' && !ownedStorageMode();
}

/** The shell's own labels: Spanish only while the landing is showing and Spanish is chosen. */
export function useShellCopy() {
  const { language } = useLandingLanguage();
  return LANDING_COPY[useLandingRoute() ? language : 'en'];
}
