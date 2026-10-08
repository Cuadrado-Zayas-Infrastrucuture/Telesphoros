import type { GuidelineFile, RecommendationRow } from '@telesphoros/cpic-schema';
import { contentSha256 } from '../knowledge/content-hash';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { recordHash } from './strict-json';
import { GENES, type GeneState, type LookupReason, type RowSelector, type SertralineRoutingPolicyV1 } from './contracts';

export const selectorOf = (id: string, row: RecommendationRow): RowSelector => ({
  guidelineId: id, table: row.locator.table, row: row.locator.row, column: row.locator.column ?? null,
});
const key = (selector: RowSelector) => recordHash(selector);
const sameGenes = (a: readonly string[], b: readonly string[]) => [...a].sort().join('+') === [...b].sort().join('+');
export type PolicyCheck = { ok: true } | { ok: false; reasonCode: LookupReason };

/** Validate every locator, not just the route that would happen to be chosen. No clinical wording escapes. */
export function validatePolicyKnowledge(policy: SertralineRoutingPolicyV1, knowledge: KnowledgeSet, disputes: readonly RowSelector[]): PolicyCheck {
  const invalid = { ok: false, reasonCode: 'lookup-policy-invalid' } as const;
  if (knowledge.mode !== 'non-production' || policy.knowledgeSetId !== knowledge.id || !knowledge.allReviewed) return invalid;
  const ids = [policy.combinedGuidelineId, ...GENES.map((g) => policy.singleGeneGuidelineIds[g])];
  if (new Set(ids).size !== 3) return invalid;
  const guidelines = knowledge.guidelinesForDrug('sertraline');
  for (const [i, id] of ids.entries()) {
    const matches = guidelines.filter((g) => g.id === id);
    const required = i === 0 ? [...GENES] : [GENES[i - 1]!];
    if (matches.length !== 1 || !sameGenes(matches[0]!.genes, required) || matches[0]!.review.status !== 'reviewed'
        || matches[0]!.review.contentSha256 !== contentSha256(matches[0]!)) return invalid;
    const file = knowledge.files.find((f) => f.id === id && f.kind === 'guideline');
    if (!file || file.reviewStatus !== 'reviewed' || file.contentSha256 !== contentSha256(matches[0]!)) return invalid;
  }
  const seen = new Set<string>();
  for (const selector of policy.reviewedRows) {
    const k = key(selector);
    if (seen.has(k) || !ids.includes(selector.guidelineId)) return invalid;
    seen.add(k);
    const guideline = guidelines.find((g) => g.id === selector.guidelineId)!;
    const rows = guideline.recommendations.filter((r) => key(selectorOf(guideline.id, r)) === k);
    if (rows.length !== 1) return invalid;
    if (disputes.some((d) => key(d) === k) || rows[0]!.verification.state === 'disputed') return { ok: false, reasonCode: 'cell-disputed' };
    if (rows[0]!.verification.state !== 'verified') return { ok: false, reasonCode: 'cell-unverified' };
  }
  return { ok: true };
}

export type RoutedDecision =
  | { state: 'held'; reasonCode: LookupReason; selectedRow: null }
  | { state: 'no-row'; reasonCode: 'both-results-missing'; selectedRow: null }
  | { state: 'row-selected'; selectedRow: RowSelector };

/** Internal only: callers must complete admission first. Does not call the legacy supersession/fallback engine. */
export function routeAdmitted(states: readonly GeneState[], policy: SertralineRoutingPolicyV1, knowledge: KnowledgeSet): RoutedDecision {
  const hold = (reasonCode: LookupReason): RoutedDecision => ({ state: 'held', reasonCode, selectedRow: null });
  for (const state of states) {
    if (state.state === 'empty') return hold('reported-field-empty');
    if (state.state === 'sentinel') return hold('sentinel-literal-in-source');
    if (state.state === 'unresolved') return hold(state.reasonCode);
  }
  const canonical = states.filter((s): s is Extract<GeneState, { state: 'canonical' }> => s.state === 'canonical');
  if (canonical.length === 0) return { state: 'no-row', reasonCode: 'both-results-missing', selectedRow: null };
  const id = canonical.length === 2 ? policy.combinedGuidelineId : policy.singleGeneGuidelineIds[canonical[0]!.gene];
  const guideline: GuidelineFile | undefined = knowledge.guidelinesForDrug('sertraline').find((g) => g.id === id);
  if (!guideline) return hold('lookup-policy-invalid');
  const matches = guideline.recommendations.filter((r) => canonical.every((s) => r.when[s.gene] === s.phenotype));
  if (matches.length !== 1) return hold('out-of-review-scope');
  const row = matches[0]!;
  const selector = selectorOf(id, row);
  if (!policy.reviewedRows.some((s) => key(s) === key(selector))) return hold('out-of-review-scope');
  if (row.verification.state === 'disputed') return hold('cell-disputed');
  if (row.verification.state !== 'verified') return hold('cell-unverified');
  return { state: 'row-selected', selectedRow: selector };
}
