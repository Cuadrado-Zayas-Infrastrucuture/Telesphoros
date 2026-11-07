import type { GuidelineFile } from '@telesphoros/cpic-schema';
import type { KnowledgeSet } from './knowledge-set';

/** One covered combination of a guideline, written as the operator reads it: `GENEA "Poor" + GENEB "Slow"`. */
const combinationOf = (guideline: GuidelineFile, when: Readonly<Record<string, string>>) => guideline.genes.map((gene) => `${gene} "${when[gene]}"`).join(' + ');

function covered(set: KnowledgeSet): Map<string, Set<string>> {
  return new Map(set.allGuidelines().map((guideline) => [guideline.id, new Set(guideline.recommendations.map((row) => combinationOf(guideline, row.when)))]));
}

/**
 * The cells each guideline (by id) gained or lost between two knowledge sets, so a source release that drops cells is seen before it is signed
 * (audit DATA-01). A guideline that disappears loses every combination it covered. Lines are sorted, removals first; no wording is printed.
 */
export function coverageDiff(before: KnowledgeSet, after: KnowledgeSet): { lines: string[]; lost: number; guidelinesLosing: number } {
  const old = covered(before);
  const now = covered(after);
  const removed: string[] = [];
  const added: string[] = [];
  const losing = new Set<string>();
  for (const [id, cells] of old) {
    for (const cell of cells) {
      if (now.get(id)?.has(cell)) continue;
      removed.push(`REMOVED ${id}: ${cell}`);
      losing.add(id);
    }
  }
  for (const [id, cells] of now) for (const cell of cells) if (!old.get(id)?.has(cell)) added.push(`ADDED ${id}: ${cell}`);
  return { lines: [...removed.sort(), ...added.sort()], lost: removed.length, guidelinesLosing: losing.size };
}
