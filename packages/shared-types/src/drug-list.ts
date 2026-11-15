import { z } from 'zod';
import fda from './drug-list/fda-tall-man.json';

/** FDA only until written ISMP permission. Callers may supply a subsequently licensed list. Display only. */
export function tallMan(name: string, names: readonly string[] = fda.names): string {
  return names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
}

const rxcuiSchema = z.string().regex(/^[1-9][0-9]*$/);
/** A brand name is a search alias for its ingredient. Records always store the ingredient code and name, never the brand. */
const brandAliasSchema = z.strictObject({ rxcui: rxcuiSchema, name: z.string().min(1).max(300) });
export const drugListEntrySchema = z
  .strictObject({
    rxcui: rxcuiSchema,
    name: z.string().min(1).max(300),
    displayName: z.string().min(1).max(300),
    tty: z.enum(['IN', 'MIN']),
    rxnormRelease: z.string().min(1),
    brands: z.array(brandAliasSchema).min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    if (fda.names.includes(entry.name) && entry.name !== entry.name.toLowerCase()) ctx.addIssue({ code: 'custom', message: 'Canonical names must be plain RxNorm names.' });
    if (entry.displayName !== tallMan(entry.name)) ctx.addIssue({ code: 'custom', message: 'Display names must follow the cited FDA list.' });
    if (entry.brands && new Set(entry.brands.map((brand) => brand.rxcui)).size !== entry.brands.length) ctx.addIssue({ code: 'custom', message: 'A brand is listed once per ingredient.' });
  });
export type DrugListEntry = z.infer<typeof drugListEntrySchema>;
export const drugListSchema = z
  .strictObject({
    status: z.literal('verified'),
    version: z.string().regex(/^[0-9a-f]{64}$/),
    cpicRelease: z.string().min(1),
    cpicSource: z.url(),
    prescribableSource: z.url().optional(),
    accessedAt: z.iso.datetime(),
    rxnormRelease: z.string().min(1),
    attribution: z.string().min(1),
    currencyNotice: z.string().min(1),
    citations: z.array(z.string().min(1)).min(3),
    sourceProperties: z.array(z.strictObject({ rxcui: z.string(), name: z.string(), tty: z.enum(['IN', 'MIN']) })).min(1),
    brandProperties: z.array(z.strictObject({ rxcui: rxcuiSchema, name: z.string().min(1), tty: z.literal('BN'), ingredients: z.array(rxcuiSchema).min(1) })).optional(),
    entries: z.array(drugListEntrySchema).min(1),
  })
  .superRefine((list, ctx) => {
    const evidence = new Map(list.sourceProperties.map((p) => [p.rxcui, p]));
    if (
      evidence.size !== list.sourceProperties.length ||
      evidence.size !== list.entries.length ||
      list.entries.some((e) => evidence.get(e.rxcui)?.name !== e.name || evidence.get(e.rxcui)?.tty !== e.tty)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Every canonical name and ingredient type must match the retained RxNav source properties.' });
    }
    if (new Set(list.entries.map((e) => e.rxcui)).size !== list.entries.length) ctx.addIssue({ code: 'custom', message: 'RxCUIs must be unique.' });
    if (list.entries.some((e) => e.rxnormRelease !== list.rxnormRelease)) ctx.addIssue({ code: 'custom', message: 'Every entry must use the recorded RxNorm release.' });
    // Every alias on an entry is backed by retained brand evidence naming that ingredient, and every piece of evidence appears on its entries.
    const brands = new Map((list.brandProperties ?? []).map((b) => [b.rxcui, b]));
    const pairs = new Set(list.entries.flatMap((e) => (e.brands ?? []).map((b) => `${b.rxcui}>${e.rxcui}`)));
    const evidencePairs = new Set((list.brandProperties ?? []).flatMap((b) => b.ingredients.map((rxcui) => `${b.rxcui}>${rxcui}`)));
    if (
      brands.size !== (list.brandProperties ?? []).length ||
      list.entries.some((e) => (e.brands ?? []).some((b) => brands.get(b.rxcui)?.name !== b.name)) ||
      pairs.size !== evidencePairs.size ||
      [...evidencePairs].some((pair) => !pairs.has(pair))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Every brand alias must match the retained RxNav brand evidence.' });
    }
  });
export type DrugList = z.infer<typeof drugListSchema>;

/** Plain accessible name is kept beside the visual form; search never depends on capitals. */
export function drugPresentation(entry: Pick<DrugListEntry, 'name'>): { displayName: string; ariaLabel: string } {
  return { displayName: tallMan(entry.name), ariaLabel: entry.name };
}
export function matchesDrug(entry: Pick<DrugListEntry, 'name'>, search: string): boolean {
  return entry.name.toLowerCase().includes(search.trim().toLowerCase());
}

export interface DrugSuggestion {
  entry: DrugListEntry;
  /** The brand name the search matched, shown beside the ingredient. Absent when the ingredient name matched. */
  brand?: string;
}
/** Lower is better: whole name, then start of name, then start of a word, then anywhere. A name match beats a brand match at the same level. */
function score(text: string, needle: string): number | null {
  const lower = text.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.split(/[\s/,()-]+/).some((word) => word.startsWith(needle))) return 2;
  return lower.includes(needle) ? 3 : null;
}
/** Local type-ahead ranking over ingredient names and brand aliases. Nothing typed leaves the browser. */
export function rankDrugs(entries: readonly DrugListEntry[], search: string, limit: number): DrugSuggestion[] {
  const needle = search.trim().toLowerCase();
  if (needle.length < 2) return [];
  const ranked: { suggestion: DrugSuggestion; rank: number }[] = [];
  for (const entry of entries) {
    const byName = score(entry.name, needle);
    let best: { rank: number; brand?: string } | null = byName === null ? null : { rank: byName * 2 };
    for (const brand of entry.brands ?? []) {
      const byBrand = score(brand.name, needle);
      if (byBrand !== null && (best === null || byBrand * 2 + 1 < best.rank)) best = { rank: byBrand * 2 + 1, brand: brand.name };
    }
    if (best) ranked.push({ suggestion: best.brand ? { entry, brand: best.brand } : { entry }, rank: best.rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.suggestion.entry.name.length - b.suggestion.entry.name.length || a.suggestion.entry.name.localeCompare(b.suggestion.entry.name))
    .slice(0, limit)
    .map((item) => item.suggestion);
}
