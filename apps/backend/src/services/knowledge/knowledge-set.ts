import type { GeneMapFile, GuidelineFile } from '@telesphoros/cpic-schema';

export interface KnowledgeFileInfo {
  /** Path relative to the knowledge directory, with "/" separators. */
  readonly path: string;
  readonly kind: 'gene-phenotype-map' | 'guideline';
  readonly id: string;
  readonly synthetic: boolean;
  readonly reviewStatus: 'reviewed' | 'unreviewed';
  readonly contentSha256: string;
  /** Under the production rules only: the signers whose signatures over this file verified (audit CLIN-01). Absent otherwise. */
  readonly signedBy?: readonly string[];
}

/**
 * Everything the engine knows, validated and immutable. Built only by `loadKnowledge`, which has
 * already enforced the production rules (reviewed content only, no test content).
 */
/** The genes a guideline is read by, sorted and joined: the same for the same set of genes, whatever order the file lists them in. */
export const genesKey = (guideline: Pick<GuidelineFile, 'genes'>): string => [...guideline.genes].sort().join('+');

export class KnowledgeSet {
  private readonly geneMaps: ReadonlyMap<string, GeneMapFile>;
  private readonly byDrug: ReadonlyMap<string, readonly GuidelineFile[]>;
  private readonly drugByRxcui = new Map<string, string>();
  private readonly rxcuiByDrug = new Map<string, string>();
  private readonly geneByHgnc = new Map<string, string>();
  private readonly hgncByGene = new Map<string, string>();

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
    for (const list of grouped.values()) list.sort((a, b) => (genesKey(a) < genesKey(b) ? -1 : genesKey(a) > genesKey(b) ? 1 : 0));
    this.byDrug = grouped;
    this.indexIdentifiers(geneMaps, guidelines);
  }

  /**
   * Spec 039 IK-3: the identifier lookups, from schema 1.3 files only. The loader refuses a conflict first, naming the files (IK-1); this
   * check is for the sets built without it (the dispute overlay copies a loaded set), where a map would otherwise keep the last file
   * silently. Names in a message are sorted, so it does not depend on file order, and no id is printed.
   */
  private indexIdentifiers(geneMaps: readonly GeneMapFile[], guidelines: readonly GuidelineFile[]): void {
    for (const guideline of guidelines) {
      if (guideline.schemaVersion !== '1.3' || guideline.rxcui === undefined) continue;
      const stated = this.rxcuiByDrug.get(guideline.drug);
      if (stated !== undefined && stated !== guideline.rxcui) throw new Error(`KnowledgeSet: drug "${guideline.drug}" states two RxNorm ids.`);
      const owner = this.drugByRxcui.get(guideline.rxcui);
      if (owner !== undefined && owner !== guideline.drug) {
        const [a, b] = [owner, guideline.drug].sort();
        throw new Error(`KnowledgeSet: drugs "${a}" and "${b}" state one RxNorm id.`);
      }
      this.rxcuiByDrug.set(guideline.drug, guideline.rxcui);
      this.drugByRxcui.set(guideline.rxcui, guideline.drug);
    }
    for (const map of geneMaps) {
      if (map.schemaVersion !== '1.3' || map.hgncId === undefined) continue;
      const owner = this.geneByHgnc.get(map.hgncId);
      if (owner !== undefined && owner !== map.gene) {
        const [a, b] = [owner, map.gene].sort();
        throw new Error(`KnowledgeSet: genes ${a} and ${b} state one HGNC id.`);
      }
      this.geneByHgnc.set(map.hgncId, map.gene);
      this.hgncByGene.set(map.gene, map.hgncId);
    }
  }

  /** The drug whose schema 1.3 guidelines state this RxNorm id. Exact match only: no case folding, trimming or lookup by name. */
  drugForRxcui(rxcui: string): string | undefined {
    return this.drugByRxcui.get(rxcui);
  }

  /** The RxNorm id a drug's schema 1.3 guidelines state; none for a drug only 1.2 files describe. */
  rxcuiOfDrug(drug: string): string | undefined {
    return this.rxcuiByDrug.get(drug);
  }

  /** The gene whose schema 1.3 phenotype map states this HGNC id. Exact match only. */
  geneForHgnc(hgncId: string): string | undefined {
    return this.geneByHgnc.get(hgncId);
  }

  /** The HGNC id a gene's schema 1.3 phenotype map states; none for a 1.2 map. */
  hgncOfGene(gene: string): string | undefined {
    return this.hgncByGene.get(gene);
  }

  /** Every gene map and every guideline, for building a derived set (the dispute overlay). The files themselves are shared, not copied. */
  allGeneMaps(): GeneMapFile[] {
    return [...this.geneMaps.values()];
  }

  allGuidelines(): GuidelineFile[] {
    return [...this.byDrug.values()].flat();
  }

  gene(symbol: string): GeneMapFile | undefined {
    return this.geneMaps.get(symbol);
  }

  /** Guidelines for a drug, ordered by their genes. Drug names are lower case. */
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
