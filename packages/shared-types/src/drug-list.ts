import { z } from 'zod';
import fda from './drug-list/fda-tall-man.json';
import bundled from './drug-list/bundled.json';

/** FDA only until written ISMP permission. Callers may supply a subsequently licensed list. Display only. */
export function tallMan(name: string, names: readonly string[] = fda.names): string {
  return names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
}

export const drugListEntrySchema = z
  .strictObject({
    rxcui: z.string().regex(/^[1-9][0-9]*$/),
    name: z.string().min(1).max(300),
    displayName: z.string().min(1).max(300),
    tty: z.enum(['IN', 'MIN']),
    rxnormRelease: z.string().min(1),
  })
  .superRefine((entry, ctx) => {
    if (fda.names.includes(entry.name) && entry.name !== entry.name.toLowerCase()) ctx.addIssue({ code: 'custom', message: 'Canonical names must be plain RxNorm names.' });
    if (entry.displayName !== tallMan(entry.name)) ctx.addIssue({ code: 'custom', message: 'Display names must follow the cited FDA list.' });
  });
export type DrugListEntry = z.infer<typeof drugListEntrySchema>;
export const drugListSchema = z
  .strictObject({
    status: z.literal('verified'),
    version: z.string().regex(/^[0-9a-f]{64}$/),
    cpicRelease: z.string().min(1),
    cpicSource: z.url(),
    accessedAt: z.iso.datetime(),
    rxnormRelease: z.string().min(1),
    attribution: z.string().min(1),
    currencyNotice: z.string().min(1),
    citations: z.array(z.string().min(1)).min(3),
    sourceProperties: z.array(z.strictObject({ rxcui: z.string(), name: z.string(), tty: z.enum(['IN', 'MIN']) })).min(1),
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
  });
export type DrugList = z.infer<typeof drugListSchema>;
/** An absent verified artifact disables writes; a fabricated fallback list is never used. */
export const BUNDLED_DRUG_LIST: DrugList | null = 'status' in bundled && bundled.status === 'verified' ? drugListSchema.parse(bundled) : null;

/** Plain accessible name is kept beside the visual form; search never depends on capitals. */
export function drugPresentation(entry: Pick<DrugListEntry, 'name'>): { displayName: string; ariaLabel: string } {
  return { displayName: tallMan(entry.name), ariaLabel: entry.name };
}
export function matchesDrug(entry: Pick<DrugListEntry, 'name'>, search: string): boolean {
  return entry.name.toLowerCase().includes(search.trim().toLowerCase());
}
