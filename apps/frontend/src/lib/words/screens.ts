import { createContext, useContext } from 'react';
import type { AppLanguage } from '@/lib/appLanguage';
import type { WordShape, WordTable, Words } from './defineWords';

/*
 * Whole screens, never loose strings (spec 050 LS-D1). A route names its screen in `handle.screen` (LS1-D2); the frame is the `shell`. A screen
 * shows Spanish only when the app's language is Spanish and the screen is listed in TRANSLATED_SCREENS, which a slice does once every fixed
 * string on it has signed Spanish (R5). Every other screen stays wholly English, marked `lang="en"` while the app is in Spanish (R6).
 */
export const SCREENS = ['shell', 'home', 'patient', 'sign-in'] as const;
export type Screen = (typeof SCREENS)[number];

/** Empty until slice LS2: no screen has Spanish yet. */
export const TRANSLATED_SCREENS: ReadonlySet<Screen> = new Set<Screen>();

export interface ScreenLanguageValue {
  /** The language this screen shows. */
  readonly language: AppLanguage;
  /** Whether this screen is translated, so its dates and numbers follow its language (R11). */
  readonly translated: boolean;
}

/** Outside any screen: English, untranslated, so dates keep the browser's locale as before. */
export const ScreenLanguageContext = createContext<ScreenLanguageValue>({ language: 'en', translated: false });

export function screenLanguage(app: AppLanguage, screen: Screen | undefined, translated: ReadonlySet<Screen> = TRANSLATED_SCREENS): ScreenLanguageValue {
  const listed = screen !== undefined && translated.has(screen);
  return { language: listed ? app : 'en', translated: listed };
}

export const useScreenLanguage = () => useContext(ScreenLanguageContext);

/** A table's words in the screen's language. A table with no Spanish gives its English, but a listed screen has Spanish in every table (R5). */
export function wordsIn<T extends WordShape>(table: WordTable<T>, language: AppLanguage): Words<T> {
  if (language === 'es' && table.es) return table.es;
  // The English is the table's own literal type; it is always a valid Words<T>, which only widens each value.
  return table.en as unknown as Words<T>;
}

export function useWords<T extends WordShape>(table: WordTable<T>): Words<T> {
  return wordsIn(table, useScreenLanguage().language);
}
