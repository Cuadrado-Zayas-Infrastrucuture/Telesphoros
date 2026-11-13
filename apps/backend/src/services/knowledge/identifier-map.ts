import { isRxcuiForm } from '@telesphoros/cpic-schema';
import type { KnowledgeSet } from './knowledge-set';

/** A guideline file of the matched drug. `supersededBy` names the combined table that replaces it, so no caller takes it for a current file. */
export interface MatchedGuideline {
  readonly id: string;
  readonly supersededBy: string | null;
}

/**
 * The answer for one RxNorm id (spec 039 IK-4). "not-matched" says only that no guideline in this knowledge set states the id: it never means
 * that no guidance exists for the drug. "invalid-identifier" is an id in neither RxNorm form; a well-formed id no guideline states is
 * "no-identified-guideline", in a real, synthetic, mixed or empty set alike.
 */
export type IngredientMatch =
  | { readonly rxcui: string; readonly status: 'matched'; readonly drug: string; readonly guidelines: readonly MatchedGuideline[] }
  | { readonly rxcui: string; readonly status: 'not-matched'; readonly reason: 'no-identified-guideline' | 'invalid-identifier' };

/**
 * The contract between a medication's RxNorm ingredient ids and the knowledge set: one answer per id, in the order given, a repeated id
 * answered again in its place. A pure function of the set and the ids: it matches by id only, never by drug name, logs nothing and holds no
 * guideline content. Nothing calls it yet (spec 039 IK-6); its clinical approval belongs to spec 031's named signer (D7).
 */
export function mapRxNormIngredients(knowledge: KnowledgeSet, ids: readonly string[]): IngredientMatch[] {
  return ids.map((rxcui): IngredientMatch => {
    if (!isRxcuiForm(rxcui)) return { rxcui, status: 'not-matched', reason: 'invalid-identifier' };
    const drug = knowledge.drugForRxcui(rxcui);
    if (drug === undefined) return { rxcui, status: 'not-matched', reason: 'no-identified-guideline' };
    const files = knowledge.guidelinesForDrug(drug);
    // As the engine reads it: a combined table replaces the narrower tables it names.
    const replacedBy = new Map(files.flatMap((file) => file.supersedes.map((id) => [id, file.id] as const)));
    const guidelines = files.map((file) => ({ id: file.id, supersededBy: replacedBy.get(file.id) ?? null })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { rxcui, status: 'matched', drug, guidelines };
  });
}
