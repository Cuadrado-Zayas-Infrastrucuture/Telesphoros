import { useScreenLanguage } from '@/lib/words/screens';

/** A date and time for display, in the given locale (`undefined`: the reader's browser). */
const whenIn = (locale: string | undefined, iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

/** A date and time for display, in the reader's locale. */
export const when = (iso: string) => whenIn(undefined, iso);

/**
 * A calendar date (YYYY-MM-DD, such as a date of birth) in the given locale, in the same medium style as `when` (specs/041 D3). It is built from its
 * year, month and day in UTC, so no time zone can move it to the day before. Anything that is not such a date is returned unchanged.
 */
function onDateIn(locale: string | undefined, date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (at.getUTCMonth() !== Number(match[2]) - 1 || at.getUTCDate() !== Number(match[3])) return date;
  return at.toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });
}

/** A calendar date in the reader's locale. */
export const onDate = (date: string) => onDateIn(undefined, date);

/** Spec 050 LS1-D4: the locales of a translated screen. The founders and the first clinicians are in Puerto Rico. */
export const SCREEN_LOCALES = { en: 'en-US', es: 'es-PR' } as const;

/** Formatters in a given locale (`undefined`: the browser's). */
export function formatIn(locale: string | undefined) {
  return {
    when: (iso: string) => whenIn(locale, iso),
    onDate: (date: string) => onDateIn(locale, date),
    number: (value: number) => value.toLocaleString(locale),
  };
}

/**
 * Spec 050 R11: dates and numbers in the screen's language on a translated screen, and in the browser's locale on every other screen, as before. A
 * screen uses this as it is translated; until then the plain `when` and `onDate` above are unchanged.
 */
export function useFormat() {
  const { language, translated } = useScreenLanguage();
  return formatIn(translated ? SCREEN_LOCALES[language] : undefined);
}
