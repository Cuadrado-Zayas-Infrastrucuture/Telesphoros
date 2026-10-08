import { canonicalDiplotype, type GeneMapFile, type ReasonCode, splitDiplotype, toHundredths } from '@telesphoros/cpic-schema';

/** What turning a diplotype into a phenotype gives: a phenotype, or the reason it could not be done. */
export type PhenotypeMapping =
  | { status: 'determined'; gene: string; diplotype: string; phenotype: string; activityScore: number | null }
  | { status: 'unresolved'; gene: string; reasonCode: Extract<ReasonCode, 'malformed-diplotype' | 'allele-not-in-definitions' | 'no-phenotype-mapping' | 'no-gene-definition'> };

/**
 * Turns one gene's diplotype into a phenotype using that gene's tables. A pure function: no I/O,
 * no logging, no clock. It never guesses. Anything it cannot decide exactly comes back as
 * "unresolved" with a reason code, and the input value is never copied into a message.
 */
export function mapPhenotype(map: GeneMapFile, diplotype: string): PhenotypeMapping {
  const unresolved = (reasonCode: Extract<PhenotypeMapping, { status: 'unresolved' }>['reasonCode']): PhenotypeMapping => ({
    status: 'unresolved',
    gene: map.gene,
    reasonCode,
  });

  // A gene reported as a phenotype has no allele tables: a diplotype for it cannot be interpreted.
  if (map.alleles === undefined || map.method === undefined) return unresolved('no-gene-definition');
  const { alleles, method } = map;

  if (!splitDiplotype(diplotype)) return unresolved('malformed-diplotype');
  const names = alleles.map((allele) => allele.name);
  const canonical = canonicalDiplotype(names, diplotype);
  if (!canonical) return unresolved('allele-not-in-definitions');

  const [first, second] = canonical.split('/') as [string, string];
  const alleleA = alleles.find((allele) => allele.name === first)!;
  const alleleB = alleles.find((allele) => allele.name === second)!;
  const determined = (phenotype: string, activityScore: number | null): PhenotypeMapping => ({
    status: 'determined',
    gene: map.gene,
    diplotype: canonical,
    phenotype,
    activityScore,
  });

  switch (method.type) {
    case 'diplotype-table': {
      const row = method.rows.find((candidate) => canonicalDiplotype(names, candidate.diplotype) === canonical);
      return row ? determined(row.phenotype, null) : unresolved('no-phenotype-mapping');
    }
    case 'function-pair': {
      const pair = [alleleA.function, alleleB.function].sort();
      const row = method.rows.find((candidate) => {
        const rowPair = [...candidate.functions].sort();
        return rowPair[0] === pair[0] && rowPair[1] === pair[1];
      });
      return row ? determined(row.phenotype, null) : unresolved('no-phenotype-mapping');
    }
    case 'activity-score': {
      if (alleleA.activityValue === undefined || alleleB.activityValue === undefined) return unresolved('no-phenotype-mapping');
      const score = toHundredths(alleleA.activityValue) + toHundredths(alleleB.activityValue);
      const row = method.ranges.find((range) => {
        const low = toHundredths(range.min);
        const high = toHundredths(range.max);
        return (score > low || (score === low && range.minInclusive)) && (score < high || (score === high && range.maxInclusive));
      });
      return row ? determined(row.phenotype, score / 100) : unresolved('no-phenotype-mapping');
    }
  }
}
