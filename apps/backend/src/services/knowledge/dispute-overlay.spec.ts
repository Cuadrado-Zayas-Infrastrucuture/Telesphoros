import { resolve } from 'node:path';
import { evaluate } from '../recommendation-engine/recommendation-engine';
import { applyDisputeOverlay, cellKey, type DisputedCell, effectiveKnowledgeSetId, OVERLAY_NOTE } from './dispute-overlay';
import { loadKnowledge } from './knowledge-loader';
import type { KnowledgeSet } from './knowledge-set';

// The overlay can only TIGHTEN, never loosen (specification 5.3). Run on the repository's test-only knowledge (invented content).
const TEST_KNOWLEDGE = resolve(__dirname, '../../../../../data/fixtures/knowledge/test-only-reader');

describe('applyDisputeOverlay', () => {
  let base: KnowledgeSet;
  beforeAll(async () => {
    base = await loadKnowledge({ directory: TEST_KNOWLEDGE, mode: 'non-production' });
  });

  const cells = () => base.allGuidelines().flatMap((g) => g.recommendations.map((row) => ({ guideline: g, row })));
  const hash = (guidelineId: string) => base.files.find((f) => f.id === guidelineId)!.contentSha256;
  const dispute = (guideline: { id: string; guidelineVersion: string }, row: { locator: { table: string; row: string; column?: string } }, over: Partial<DisputedCell> = {}): DisputedCell => ({
    guidelineId: guideline.id, guidelineVersion: guideline.guidelineVersion, guidelineContentSha256: hash(guideline.id), locator: { ...row.locator }, ...over,
  });
  const verified = () => cells().find((c) => c.row.verification.state === 'verified')!;
  const unverified = () => cells().find((c) => c.row.verification.state === 'unverified')!;
  const alreadyDisputed = () => cells().find((c) => c.row.verification.state === 'disputed')!;
  const stateOf = (set: KnowledgeSet, guidelineId: string, row: { locator: { table: string; row: string } }) =>
    set.allGuidelines().find((g) => g.id === guidelineId)!.recommendations.find((r) => r.locator.table === row.locator.table && r.locator.row === row.locator.row)!.verification;

  it('has the three kinds of cell this suite needs (a floor, so a changed fixture cannot make the other tests vacuous)', () => {
    expect([verified(), unverified(), alreadyDisputed()].every(Boolean)).toBe(true);
    expect(cells().length).toBeGreaterThanOrEqual(6);
  });

  it('makes a verified cell disputed, with the fixed note, and nothing else changes', () => {
    const { guideline, row } = verified();
    const result = applyDisputeOverlay(base, [dispute(guideline, row)]);
    expect(stateOf(result.knowledge, guideline.id, row)).toEqual({ state: 'disputed', note: OVERLAY_NOTE });
    expect(result.cellKeys).toEqual([cellKey(dispute(guideline, row))]);
    // every other cell of every guideline is exactly as before
    for (const other of cells()) {
      if (other.guideline.id === guideline.id && other.row.locator.row === row.locator.row && other.row.locator.table === row.locator.table) continue;
      expect(stateOf(result.knowledge, other.guideline.id, other.row)).toEqual(other.row.verification);
    }
    expect(result.knowledge.drugs()).toEqual(base.drugs());
    expect(result.knowledge.files).toBe(base.files);
  });

  it('never modifies the set it is given (it is shared by every request)', () => {
    const { guideline, row } = verified();
    const before = JSON.stringify(base.allGuidelines());
    applyDisputeOverlay(base, [dispute(guideline, row)]);
    expect(JSON.stringify(base.allGuidelines())).toBe(before);
    expect(stateOf(base, guideline.id, row).state).toBe('verified');
  });

  it('can only tighten: an unverified or already disputed cell is unchanged, and nothing is reported as changed', () => {
    for (const { guideline, row } of [unverified(), alreadyDisputed()]) {
      const result = applyDisputeOverlay(base, [dispute(guideline, row)]);
      expect(result.knowledge).toBe(base); // not even a copy
      expect(result.cellKeys).toEqual([]);
      expect(result.knowledge.id).toBe(base.id);
    }
  });

  it('no disputes: the very same set and the same id', () => {
    const result = applyDisputeOverlay(base, []);
    expect(result).toEqual({ knowledge: base, cellKeys: [] });
  });

  it('a dispute about another version or an older file hash changes nothing (the corrected, re-signed file lifts the hold)', () => {
    const { guideline, row } = verified();
    for (const over of [{ guidelineContentSha256: 'a'.repeat(64) }, { guidelineVersion: `${guideline.guidelineVersion}-other` }, { guidelineId: 'no-such-guideline' }]) {
      const result = applyDisputeOverlay(base, [dispute(guideline, row, over)]);
      expect(result.knowledge).toBe(base);
      expect(result.cellKeys).toEqual([]);
    }
    // control: the matching dispute does change it
    expect(applyDisputeOverlay(base, [dispute(guideline, row)]).cellKeys).toHaveLength(1);
  });

  it('a locator that matches no cell changes nothing; a column is part of the locator', () => {
    const { guideline, row } = verified();
    expect(applyDisputeOverlay(base, [dispute(guideline, row, { locator: { ...row.locator, row: 'no such row' } })]).knowledge).toBe(base);
    expect(applyDisputeOverlay(base, [dispute(guideline, row, { locator: { ...row.locator, column: 'some column' } })]).knowledge).toBe(base);
  });

  it('the effective id differs from the base id, is stable, ignores order and duplicates, and depends on which cells changed', () => {
    const [a, b] = cells().filter((c) => c.row.verification.state === 'verified');
    const da = dispute(a!.guideline, a!.row);
    const db = dispute(b!.guideline, b!.row);
    const idOf = (list: DisputedCell[]) => applyDisputeOverlay(base, list).knowledge.id;
    expect(idOf([da])).not.toBe(base.id);
    expect(idOf([da])).toBe(idOf([da, da]));
    expect(idOf([da, db])).toBe(idOf([db, da]));
    expect(idOf([da])).not.toBe(idOf([db]));
    expect(idOf([da, db])).not.toBe(idOf([da]));
    expect(idOf([da])).toBe(effectiveKnowledgeSetId(base.id, [cellKey(da)]));
    expect(effectiveKnowledgeSetId(base.id, [])).toBe(base.id);
    expect(idOf([da])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the engine holds a disputed cell with its citation and NO wording, and the other drug is untouched (D01 inputs from the hand-written golden)', () => {
    const inputs = [{ gene: 'CYP2C19', state: 'diplotype' as const, diplotype: '*1/*2' }, { gene: 'CYP2B6', state: 'diplotype' as const, diplotype: '*1/*1' }];
    const before = evaluate(base, inputs);
    const shown = before.results.find((r) => r.drug === 'drugq')!;
    expect(shown).toMatchObject({ outcome: 'shown', recommendationText: 'Q intermediate.' }); // control: shown without a dispute
    const cited = (shown as { citation: { guidelineId: string; locator: { table: string; row: string; column?: string | null } } }).citation;
    const guideline = base.allGuidelines().find((g) => g.id === cited.guidelineId)!;
    const overlaid = applyDisputeOverlay(base, [dispute(guideline, { locator: { table: cited.locator.table, row: cited.locator.row, column: cited.locator.column ?? undefined } })]);
    expect(overlaid.cellKeys).toHaveLength(1);

    const after = evaluate(overlaid.knowledge, inputs);
    expect(after.knowledgeSetId).toBe(overlaid.knowledge.id);
    expect(after.results.find((r) => r.drug === 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed', citation: { guidelineId: cited.guidelineId } });
    expect(JSON.stringify(after.results.find((r) => r.drug === 'drugq'))).not.toContain('Q intermediate.');
    expect(after.results.find((r) => r.drug === 'drugr')).toEqual(before.results.find((r) => r.drug === 'drugr')); // an unrelated drug is unchanged
    expect(after.geneStates).toEqual(before.geneStates);
  });
});
