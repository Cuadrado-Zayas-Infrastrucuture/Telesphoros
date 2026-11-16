/** A date and time for display, in the reader's locale. */
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * A calendar date (YYYY-MM-DD, such as a date of birth) in the reader's locale, in the same medium style as `when`
 * (specs/041 D3). It is built from its year, month and day in UTC, so no time zone can move it to the day before.
 * Anything that is not such a date is returned unchanged.
 */
export function onDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (at.getUTCMonth() !== Number(match[2]) - 1 || at.getUTCDate() !== Number(match[3])) return date;
  return at.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
}
