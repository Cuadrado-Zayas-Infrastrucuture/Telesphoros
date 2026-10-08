/**
 * Diplotype helpers shared by the knowledge-file validation and the engine, so the two can never
 * disagree on what "*1/*2" means. Version 1 handles diploid genes only, written "allele/allele".
 */

/** Splits "a/b" into its two alleles, or returns undefined if the text is not exactly that form. */
export function splitDiplotype(text: string): [string, string] | undefined {
  const parts = text.split('/');
  if (parts.length !== 2) return undefined;
  const [first, second] = parts as [string, string];
  if (first === '' || second === '') return undefined;
  if (first !== first.trim() || second !== second.trim()) return undefined;
  return [first, second];
}

/**
 * The one spelling of a diplotype: its two alleles ordered by their position in the gene's allele
 * list. "*2/*1" and "*1/*2" are the same diplotype. Returns undefined if an allele is unknown.
 */
export function canonicalDiplotype(alleleNames: readonly string[], text: string): string | undefined {
  const parts = splitDiplotype(text);
  if (!parts) return undefined;
  const first = alleleNames.indexOf(parts[0]);
  const second = alleleNames.indexOf(parts[1]);
  if (first === -1 || second === -1) return undefined;
  return first <= second ? `${parts[0]}/${parts[1]}` : `${parts[1]}/${parts[0]}`;
}

/** Activity scores are compared as whole hundredths so 0.1 + 0.2 is exactly 0.3. */
export function toHundredths(value: number): number {
  return Math.round(value * 100);
}

/** True if the number has at most two decimal places. */
export function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}
