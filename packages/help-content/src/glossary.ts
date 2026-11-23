import { z } from 'zod';
import glossaryEn from './glossary.en.json';

/**
 * Spec 044 slice B part 2 (decisions B-D4, B2-D1, B2-D2): the glossary. General education about a term, the same for every patient and
 * never about one. The screens and the help assistant read this one file, so they cannot say different things. An entry is `draft` until
 * two pharmacists have reviewed it and are named, with the date, in `signedBy`; the screen says which it is. This is a recorded sign-off,
 * not a cryptographic signature (B2-D1).
 */
const signerSchema = z.strictObject({
  name: z.string().min(1),
  role: z.string().min(1),
  date: z.iso.date(),
});

function signersMatchStatus(entry: { status: 'draft' | 'signed'; signedBy: readonly unknown[] }): boolean {
  return entry.status === 'signed' ? entry.signedBy.length >= 2 : entry.signedBy.length === 0;
}

export const glossaryEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    term: z.string().min(1),
    /** The exact strings the screen shows for this term. Matched whole, ignoring letter case and repeated spaces; never guessed. */
    aliases: z.array(z.string().min(1)).min(1),
    /** Plain text: a few short sentences, no markup and no links. */
    body: z.string().min(1),
    status: z.enum(['draft', 'signed']),
    signedBy: z.array(signerSchema),
    /** What a reviewer read the entry against, when they record it. */
    reviewedAgainst: z.array(z.string().min(1)).optional(),
  })
  .refine(signersMatchStatus, { message: 'A signed entry names at least two pharmacists, and a draft names none.' });

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

/** How a screen string is compared with an alias: whole, ignoring letter case and repeated spaces. */
export function normalizeTerm(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const glossaryFileSchema = z
  .strictObject({
    language: z.literal('en'),
    entries: z.array(glossaryEntrySchema),
  })
  .superRefine((file, context) => {
    const ids = new Set<string>();
    const aliases = new Set<string>();
    for (const entry of file.entries) {
      if (ids.has(entry.id)) context.addIssue({ code: 'custom', message: `The id ${entry.id} is used twice.` });
      ids.add(entry.id);
      for (const alias of entry.aliases) {
        const key = normalizeTerm(alias);
        if (aliases.has(key)) context.addIssue({ code: 'custom', message: `The alias "${alias}" belongs to two entries.` });
        aliases.add(key);
      }
    }
  });

export type GlossaryFile = z.infer<typeof glossaryFileSchema>;

/** The English glossary, refused at load if it breaks a rule above. */
export const GLOSSARY_EN: readonly GlossaryEntry[] = glossaryFileSchema.parse(glossaryEn).entries;

const byAlias = new Map(GLOSSARY_EN.flatMap((entry) => entry.aliases.map((alias) => [normalizeTerm(alias), entry] as const)));

/** The entry whose alias is exactly this text, or null: a screen string with no entry stays plain text. */
export function glossaryEntryFor(text: string): GlossaryEntry | null {
  return byAlias.get(normalizeTerm(text)) ?? null;
}
