import { canonicalDiplotype, type GeneMapFile, type PhenotypeResult, splitDiplotype, toHundredths } from '@telesphoros/cpic-schema';

/**
 * Turns one gene's diplotype into a phenotype using that gene's tables. A pure function: no I/O,
 * no logging, no clock. It never guesses. Anything it cannot decide exactly comes back as
 * "indeterminate" with a reason code, and the input value is never copied into a message.
 */
export function mapPhenotype(map: GeneMapFile, diplotype: string): PhenotypeResult {
  const indeterminate = (reasonCode: 'MALFORMED_DIPLOTYPE' | 'ALLELE_NOT_IN_DEFINITIONS' | 'NO_PHENOTYPE_MAPPING'): PhenotypeResult => ({
    status: 'indeterminate',
    gene: map.gene,
    reasonCode,
  });

  const parts = splitDiplotype(diplotype);
  if (!parts) return indeterminate('MALFORMED_DIPLOTYPE');
  const names = map.alleles.map((allele) => allele.name);
  const canonical = canonicalDiplotype(names, diplotype);
  if (!canonical) return indeterminate('ALLELE_NOT_IN_DEFINITIONS');

  const [first, second] = canonical.split('/') as [string, string];
  const alleleA = map.alleles.find((allele) => allele.name === first)!;
  const alleleB = map.alleles.find((allele) => allele.name === second)!;
  const determined = (phenotype: string, activityScore: number | null): PhenotypeResult => ({
    status: 'determined',
    gene: map.gene,
    diplotype: canonical,
    phenotype,
    activityScore,
  });

  switch (map.method.type) {
    case 'diplotype-table': {
      const row = map.method.rows.find((candidate) => canonicalDiplotype(names, candidate.diplotype) === canonical);
      return row ? determined(row.phenotype, null) : indeterminate('NO_PHENOTYPE_MAPPING');
    }
    case 'function-pair': {
      const pair = [alleleA.function, alleleB.function].sort();
      const row = map.method.rows.find((candidate) => {
        const rowPair = [...candidate.functions].sort();
        return rowPair[0] === pair[0] && rowPair[1] === pair[1];
      });
      return row ? determined(row.phenotype, null) : indeterminate('NO_PHENOTYPE_MAPPING');
    }
    case 'activity-score': {
      if (alleleA.activityValue === undefined || alleleB.activityValue === undefined) return indeterminate('NO_PHENOTYPE_MAPPING');
      const score = toHundredths(alleleA.activityValue) + toHundredths(alleleB.activityValue);
      const row = map.method.ranges.find((range) => {
        const low = toHundredths(range.min);
        const high = toHundredths(range.max);
        return (score > low || (score === low && range.minInclusive)) && (score < high || (score === high && range.maxInclusive));
      });
      return row ? determined(row.phenotype, score / 100) : indeterminate('NO_PHENOTYPE_MAPPING');
    }
  }
}
