import type { GeneMapFile, GuidelineFile } from '@telesphoros/cpic-schema';

export interface KnowledgeFileInfo {
  /** Path relative to the knowledge directory, with "/" separators. */
  readonly path: string;
  readonly kind: 'gene-phenotype-map' | 'guideline';
  readonly id: string;
  readonly synthetic: boolean;
  readonly reviewStatus: 'reviewed' | 'unreviewed';
  readonly contentSha256: string;
}

/**
 * Everything the engine knows, validated and immutable. Built only by `loadKnowledge`, which has
 * already enforced the production rules (reviewed content only, no test content).
 */
export class KnowledgeSet {
  private readonly geneMaps: ReadonlyMap<string, GeneMapFile>;
  private readonly byDrug: ReadonlyMap<string, readonly GuidelineFile[]>;

  constructor(
    readonly id: string,
    readonly mode: 'production' | 'non-production',
    geneMaps: readonly GeneMapFile[],
    guidelines: readonly GuidelineFile[],
    readonly files: readonly KnowledgeFileInfo[],
  ) {
    this.geneMaps = new Map(geneMaps.map((map) => [map.gene, map]));
    const grouped = new Map<string, GuidelineFile[]>();
    for (const guideline of guidelines) {
      grouped.set(guideline.drug, [...(grouped.get(guideline.drug) ?? []), guideline]);
    }
    for (const list of grouped.values()) list.sort((a, b) => (a.gene < b.gene ? -1 : a.gene > b.gene ? 1 : 0));
    this.byDrug = grouped;
  }

  gene(symbol: string): GeneMapFile | undefined {
    return this.geneMaps.get(symbol);
  }

  /** Guidelines for a drug, ordered by gene. Drug names are lower case. */
  guidelinesForDrug(drug: string): readonly GuidelineFile[] {
    return this.byDrug.get(drug) ?? [];
  }

  /** Every drug with at least one guideline, in alphabetical order. */
  drugs(): string[] {
    return [...this.byDrug.keys()].sort();
  }

  get guidelineCount(): number {
    return [...this.byDrug.values()].reduce((total, list) => total + list.length, 0);
  }

  get isEmpty(): boolean {
    return this.guidelineCount === 0;
  }

  get containsSynthetic(): boolean {
    return this.files.some((file) => file.synthetic);
  }

  get allReviewed(): boolean {
    return this.files.every((file) => file.reviewStatus === 'reviewed');
  }
}
