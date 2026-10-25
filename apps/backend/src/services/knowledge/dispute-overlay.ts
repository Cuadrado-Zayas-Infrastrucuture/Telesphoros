import type { GuidelineFile } from '@telesphoros/cpic-schema';
import { canonicalJson, sha256Hex } from '../report-adapter/canonical-json';
import { KnowledgeSet } from './knowledge-set';

/**
 * The dispute overlay (specification 5.3). Guideline cells live in signed knowledge files; database records can only TIGHTEN them at run
 * time, never loosen them. A pure function: it reads nothing, writes nothing, and never modifies the set it is given (which is shared).
 *
 *   - Only a cell that was `verified` changes: it becomes `disputed`, which the engine already turns into a hold with no wording.
 *     A cell that is `unverified` or already `disputed` is left exactly as it is. So a dismissal (which simply is not passed in) can never
 *     make anything shown, and nothing here can show a cell the file does not.
 *   - A dispute names the file's CONTENT HASH. A corrected, re-signed file has another hash, so a dispute about the old file changes nothing:
 *     the hold lifts by itself, and the new file shows a cell only if it says `verified`.
 *   - The effective set id is derived from the base id and the cells that were actually changed, and equals the base id when none were,
 *     so a result made without any effective dispute keeps its id.
 */
export const OVERLAY_VERSION = 'overlay/1';

/** The note shown on a cell the overlay disputed. Fixed text: it is read by people, never taken from a dispute's note. */
export const OVERLAY_NOTE = 'Disputed in this tenant and held until a reviewer resolves the dispute.';

export interface DisputedCell {
  guidelineId: string;
  guidelineVersion: string;
  /** The content hash of the knowledge file that was disputed. */
  guidelineContentSha256: string;
  locator: { table: string; row: string; column?: string | null };
}

/** Identifies one cell across versions: `[guideline id, version, file content hash, table, row, column or null]`. */
export type CellKey = [string, string, string, string, string, string | null];

export const cellKey = (cell: DisputedCell): CellKey => [
  cell.guidelineId,
  cell.guidelineVersion,
  cell.guidelineContentSha256,
  cell.locator.table,
  cell.locator.row,
  cell.locator.column ?? null,
];

export interface OverlayResult {
  /** The set to evaluate against: `knowledge` itself when nothing changed, otherwise a derived set. */
  knowledge: KnowledgeSet;
  /** The keys of the cells whose state the overlay changed, sorted and without duplicates. Empty when nothing changed. */
  cellKeys: CellKey[];
}

const keyText = (key: CellKey): string => JSON.stringify(key);

/** The effective id: `sha256("overlay/1\n" + baseId + "\n" + canonicalJson(sorted keys))`, or the base id when there are no keys. */
export function effectiveKnowledgeSetId(baseId: string, cellKeys: readonly CellKey[]): string {
  if (cellKeys.length === 0) return baseId;
  return sha256Hex(`${OVERLAY_VERSION}\n${baseId}\n${canonicalJson([...cellKeys].sort((a, b) => (keyText(a) < keyText(b) ? -1 : keyText(a) > keyText(b) ? 1 : 0)))}`);
}

export function applyDisputeOverlay(knowledge: KnowledgeSet, disputes: readonly DisputedCell[]): OverlayResult {
  const hashOf = new Map(knowledge.files.filter((file) => file.kind === 'guideline').map((file) => [file.id, file.contentSha256]));
  const changed = new Map<string, CellKey>();
  let touched = false;

  const guidelines = knowledge.allGuidelines().map((guideline): GuidelineFile => {
    const wanted = disputes.filter(
      (d) => d.guidelineId === guideline.id && d.guidelineVersion === guideline.guidelineVersion && d.guidelineContentSha256 === hashOf.get(guideline.id),
    );
    if (wanted.length === 0) return guideline;

    const replaced = guideline.recommendations.map((row) => {
      if (row.verification.state !== 'verified') return row; // tighten only: an unverified or disputed cell is already held
      const hit = wanted.find((d) => d.locator.table === row.locator.table && d.locator.row === row.locator.row && (d.locator.column ?? null) === (row.locator.column ?? null));
      if (!hit) return row;
      const key = cellKey(hit);
      changed.set(keyText(key), key);
      return { ...row, verification: { state: 'disputed' as const, note: OVERLAY_NOTE } };
    });
    if (replaced.some((row, index) => row !== guideline.recommendations[index])) {
      touched = true;
      return { ...guideline, recommendations: replaced };
    }
    return guideline;
  });

  if (!touched) return { knowledge, cellKeys: [] };
  const cellKeys = [...changed.values()].sort((a, b) => (keyText(a) < keyText(b) ? -1 : keyText(a) > keyText(b) ? 1 : 0));
  const derived = new KnowledgeSet(effectiveKnowledgeSetId(knowledge.id, cellKeys), knowledge.mode, knowledge.allGeneMaps(), guidelines, knowledge.files);
  return { knowledge: derived, cellKeys };
}
