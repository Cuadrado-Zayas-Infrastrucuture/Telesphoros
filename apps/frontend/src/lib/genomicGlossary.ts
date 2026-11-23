import { createContext, useContext } from 'react';
import type { GlossaryEntry } from '@telesphoros/help-content';

/** What a term asks the genomic profile's glossary drawer to show: one entry, or the list of every entry (spec 044 slice B part 2). */
export type GlossaryView = GlossaryEntry | 'all';

export const GlossaryContext = createContext<((view: GlossaryView) => void) | null>(null);

/** Opens the glossary drawer; null outside a genomic profile section, where a term stays plain text. */
export function useGlossary(): ((view: GlossaryView) => void) | null {
  return useContext(GlossaryContext);
}
