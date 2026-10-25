import { z } from 'zod';
import type { CellUsageDto } from '@telesphoros/shared-types';
import type { DisputeInput, Projected } from '../storage/ledger-records';

const provenanceSchema = z.strictObject({
  version: z.literal('cell-provenance/1'),
  files: z.array(z.strictObject({ guidelineId: z.string(), guidelineVersion: z.string(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
const citationSchema = z.looseObject({
  guidelineId: z.string(),
  guidelineVersion: z.string(),
  locator: z.looseObject({ table: z.string(), row: z.string(), column: z.string().nullable().optional() }),
});
const resultSchema = z.looseObject({ drug: z.string(), outcome: z.string(), citation: citationSchema });

/** Never reconstruct history from today's knowledge, nor infer a file hash from a matching version string. */
export function cellMatches(record: Projected, cell: DisputeInput): CellUsageDto['entries'][number]['matches'] {
  const binding = z.looseObject({ cellProvenance: provenanceSchema }).safeParse(record.binding);
  const files = binding.success ? binding.data.cellProvenance.files.filter((f) => f.guidelineId === cell.guidelineId && f.guidelineVersion === cell.guidelineVersion) : [];
  // Missing, malformed or conflicting metadata is unverified; it never earns an exact match.
  const hashes = [...new Set(files.map((f) => f.contentSha256))];
  const hash = hashes.length === 1 ? hashes[0] : undefined;
  if (hash !== undefined && hash !== cell.guidelineContentSha256) return [];
  const matches: CellUsageDto['entries'][number]['matches'] = [];
  if (!Array.isArray(record.results)) return matches;
  record.results.forEach((raw, resultIndex) => {
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) return;
    const r = parsed.data;
    const c = r.citation;
    if (
      c.guidelineId !== cell.guidelineId ||
      c.guidelineVersion !== cell.guidelineVersion ||
      c.locator.table !== cell.locator.table ||
      c.locator.row !== cell.locator.row ||
      (c.locator.column ?? null) !== (cell.locator.column ?? null)
    )
      return;
    matches.push({
      resultIndex,
      drug: r.drug,
      outcome: r.outcome,
      identity: hash === undefined ? 'historical-identity-unverified' : 'exact-file',
      wordingExposed: (r.outcome === 'shown' || r.outcome === 'no-published-recommendation') && typeof r.recommendationText === 'string',
    });
  });
  return matches;
}
