import { glossaryEntryFor } from '@telesphoros/help-content';
import { useGlossary } from '@/lib/genomicGlossary';

/**
 * Spec 044 slice B part 2 (B2-D3): a word on the screen that has a glossary entry becomes a small text button that opens it in the side
 * drawer. A word without an entry, or outside a genomic profile section, stays plain text: nothing is guessed. `label` shows other words
 * for the same entry ("What is phenoconversion?"), and is left out entirely when there is no entry to open.
 */
export function GlossaryTerm({ text, label }: { text: string; label?: string }) {
  const open = useGlossary();
  const entry = glossaryEntryFor(text);
  if (!open || !entry) return label === undefined ? text : null;
  return (
    <button type="button" aria-haspopup="dialog" className="underline decoration-dotted underline-offset-2 hover:decoration-solid" onClick={() => open(entry)}>
      {label ?? text}
    </button>
  );
}
