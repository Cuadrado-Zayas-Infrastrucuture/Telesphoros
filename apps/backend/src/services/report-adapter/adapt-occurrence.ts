import type { GeneInput } from '@telesphoros/cpic-schema';
import type { AdapterKnowledge } from './adapter-knowledge';
import { isUnavailableValue } from './unavailable-matcher';

/** What the reader found for one role of one occurrence: nothing, a label with nothing after it, or a value. */
export type FieldState = { state: 'missing' } | { state: 'empty' } | { state: 'present'; text: string };

export interface OccurrenceFacts {
  gene: string;
  diplotype: FieldState;
  result: FieldState;
}

export type AdapterNote =
  | 'corroborated'
  | 'conflict'
  | 'result-untrusted'
  | 'unavailable'
  | 'empty-field'
  | 'no-reported-result'
  | 'nothing-stated'
  | 'abstained'
  | 'duplicate-identical'
  | 'duplicate-gene-conflict'
  | null;

/** The engine's schema allows at most this many characters in a phenotype or diplotype. */
export const MAX_VALUE_LENGTH = 100;

const unresolvedOther = (gene: string): GeneInput => ({ gene, state: 'unresolved', reasonCode: 'other-gene-unresolved' });
const nullInput = (gene: string): GeneInput => ({ gene, state: 'null' });

/**
 * One occurrence of a gene to the engine's input, exactly as docs/design/report-adapter-spec.md section 5.2 says.
 * Pure: no I/O, no clock. It never guesses, never normalizes a stored value, and never maps a diplotype itself.
 * Repeated genes are decided before this is called (see `duplicateInput`).
 */
export function adaptOccurrence(facts: OccurrenceFacts, knowledge: AdapterKnowledge): { emitted: GeneInput[]; note: AdapterNote } {
  const { gene, diplotype, result } = facts;
  const canonical = knowledge.canonicalPhenotypes(gene);

  if (diplotype.state === 'present') {
    const text = diplotype.text;
    if (text.length > MAX_VALUE_LENGTH) return { emitted: [unresolvedOther(gene)], note: null };
    const mapping = canonical === null ? ({ mapped: false } as const) : knowledge.mapDiplotype(gene, text);
    // A diplotype the tables cannot map goes to the engine as it is, so the engine gives its own precise reason.
    if (!mapping.mapped) return { emitted: [{ gene, state: 'diplotype', diplotype: text }], note: null };
    // Mappable. A diplotype with no reported result is unresolved (rule R04); the diplotype is never used to assign a phenotype.
    if (result.state === 'missing') return { emitted: [unresolvedOther(gene)], note: 'no-reported-result' };
    if (result.state === 'empty') return { emitted: [unresolvedOther(gene)], note: 'empty-field' };
    if (canonical!.includes(result.text)) {
      if (result.text === mapping.phenotype) return { emitted: [{ gene, state: 'diplotype', diplotype: text }], note: 'corroborated' };
      return { emitted: [{ gene, state: 'diplotype', diplotype: text }, { gene, state: 'canonical', phenotype: result.text }], note: 'conflict' };
    }
    return { emitted: [unresolvedOther(gene)], note: 'result-untrusted' };
  }

  if (diplotype.state === 'empty') {
    return result.state === 'present' ? { emitted: [unresolvedOther(gene)], note: 'empty-field' } : { emitted: [nullInput(gene)], note: 'empty-field' };
  }

  // No diplotype.
  if (result.state === 'empty') return { emitted: [nullInput(gene)], note: 'empty-field' };
  if (result.state === 'missing') return { emitted: [unresolvedOther(gene)], note: 'nothing-stated' };
  const text = result.text;
  if (canonical === null) {
    // No definition for the gene: the engine reports that precisely, unless the value cannot even be expressed.
    if (isUnavailableValue(text)) return { emitted: [nullInput(gene)], note: 'unavailable' };
    return text.length > MAX_VALUE_LENGTH ? { emitted: [unresolvedOther(gene)], note: 'result-untrusted' } : { emitted: [{ gene, state: 'canonical', phenotype: text }], note: null };
  }
  if (canonical.includes(text)) return { emitted: [{ gene, state: 'canonical', phenotype: text }], note: null };
  if (isUnavailableValue(text)) return { emitted: [nullInput(gene)], note: 'unavailable' };
  return { emitted: [unresolvedOther(gene)], note: 'result-untrusted' };
}

/** How the result of one occurrence came about, for deciding whether repeats are identical (rule R03). */
export type ResultBasis = 'reported-value' | 'empty-field' | 'no-reported-result' | 'nothing-stated';

export function resultBasis(facts: OccurrenceFacts): ResultBasis {
  if (facts.result.state === 'present') return 'reported-value';
  if (facts.result.state === 'empty') return 'empty-field';
  return facts.diplotype.state === 'present' ? 'no-reported-result' : 'nothing-stated';
}

const literal = (field: FieldState): readonly [string, string | null] => [field.state, field.state === 'present' ? field.text : null];

/**
 * Repeats of one gene are always held, never collapsed to a chosen value (rule R03, option A). They are identical only if
 * the gene, the literal diplotype, the literal result, the presence of each field and the result basis are all equal,
 * byte for byte: no normalization of any kind, so differently worded unavailable tokens differ, and missing differs from
 * empty. This runs before any unavailable-value matching.
 */
export function duplicateInput(gene: string, occurrences: readonly OccurrenceFacts[]): { input: GeneInput; note: 'duplicate-identical' | 'duplicate-gene-conflict' } {
  const keyOf = (facts: OccurrenceFacts) => JSON.stringify([facts.gene, literal(facts.diplotype), literal(facts.result), resultBasis(facts)]);
  const first = keyOf(occurrences[0]!);
  const identical = occurrences.every((facts) => keyOf(facts) === first);
  const reasonCode = identical ? 'duplicate-identical' : 'duplicate-gene-conflict';
  return { input: { gene, state: 'unresolved', reasonCode }, note: reasonCode };
}
