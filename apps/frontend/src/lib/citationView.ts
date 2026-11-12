import { z } from 'zod';

/**
 * A stored citation as labelled lines (specs/038 D5). The API sends the citation as an open object, so each part is read on its own: a part
 * that is absent or malformed reads as not recorded, and never costs the reader the parts that are there. Nothing is filled in from
 * anywhere else: an old result keeps the citation it was stored with.
 */
export interface CitationView {
  guideline: string | null;
  version: string | null;
  /** Where in the guideline: each part only when the stored locator carries it. */
  location: { table: string | null; row: string | null; column: string | null } | null;
  verification: { word: string; caution: boolean } | null;
  /** Only an `https` address is offered as a link. */
  sourceUrl: string | null;
  signedBy: readonly string[];
}

const text = z.string().trim().min(1);
const part = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const citationParts = z.object({
  guidelineId: part(text),
  guidelineVersion: part(text),
  sourceUrl: part(text),
  locator: part(z.object({ table: part(text), row: part(text), column: part(text) })),
  verification: part(text),
  signedBy: part(z.array(text)),
});

/** The verification states of a guideline cell, in plain words. A state this screen does not know is a caution, never "verified". */
function verificationWords(state: string): { word: string; caution: boolean } {
  switch (state) {
    case 'verified':
      return { word: 'Verified', caution: false };
    case 'unverified':
      return { word: 'Not verified', caution: true };
    case 'disputed':
      return { word: 'Disputed', caution: true };
    default:
      return { word: 'Not recognised by this screen', caution: true };
  }
}

function httpsOnly(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function citationView(citation: unknown): CitationView | null {
  if (citation === null || typeof citation !== 'object') return null;
  const read = citationParts.safeParse(citation);
  if (!read.success) return null;
  const { guidelineId, guidelineVersion, sourceUrl, locator, verification, signedBy } = read.data;
  return {
    guideline: guidelineId ?? null,
    version: guidelineVersion ?? null,
    location: locator ? { table: locator.table ?? null, row: locator.row ?? null, column: locator.column ?? null } : null,
    verification: verification ? verificationWords(verification) : null,
    sourceUrl: httpsOnly(sourceUrl),
    signedBy: signedBy ?? [],
  };
}
