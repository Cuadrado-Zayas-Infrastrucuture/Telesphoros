import type { GeneModifierEntry } from '@telesphoros/cpic-schema';

/** The loaded gene modifier lists, or undefined while GENE_MODIFIERS_DIR is unset (spec 045 PN-6). */
export const GENE_MODIFIERS = Symbol('GENE_MODIFIERS');

/** One listed modifier, with the list it comes from, so a notice can name its source, version and locator (spec 045 PN-7). */
export interface GeneModifier extends GeneModifierEntry {
  readonly listId: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly sourceVersion: string;
}

export interface GeneModifierFileInfo {
  /** The file name, relative to the gene modifier directory. */
  readonly path: string;
  readonly id: string;
  readonly synthetic: boolean;
  readonly reviewStatus: 'reviewed' | 'unreviewed';
  readonly contentSha256: string;
  /** Under the production rules only: the signers whose signatures over this file verified. Absent otherwise. */
  readonly signedBy?: readonly string[];
}

const byGene = (a: GeneModifier, b: GeneModifier) => (a.gene < b.gene ? -1 : a.gene > b.gene ? 1 : 0);

/**
 * The gene modifier lists, validated and immutable (spec 045 D2). Built only by `loadGeneModifiers`, which has already enforced the rules and
 * refused two lists that disagree. It holds no patient data and no clinical rule: it answers which listed modifiers an ingredient has, nothing else.
 */
export class GeneModifierSet {
  private readonly byRxcui: ReadonlyMap<string, readonly GeneModifier[]>;

  constructor(
    readonly id: string,
    readonly mode: 'production' | 'non-production',
    readonly files: readonly GeneModifierFileInfo[],
    modifiers: readonly GeneModifier[],
  ) {
    const grouped = new Map<string, GeneModifier[]>();
    for (const modifier of modifiers) {
      const frozen = Object.freeze({ ...modifier, locator: Object.freeze({ ...modifier.locator }) });
      grouped.set(modifier.rxcui, [...(grouped.get(modifier.rxcui) ?? []), frozen]);
    }
    this.byRxcui = new Map([...grouped].map(([rxcui, list]) => [rxcui, Object.freeze(list.sort(byGene))]));
  }

  /**
   * The listed modifiers of one ingredient, by exact RxNorm id (spec 045 D3, PN-3), sorted by gene. Empty when the ingredient is not listed,
   * which never means it changes no gene's effect (D8): the lists are not exhaustive.
   */
  modifiersOf(rxcui: string): readonly GeneModifier[] {
    return this.byRxcui.get(rxcui) ?? [];
  }

  get containsSynthetic(): boolean {
    return this.files.some((file) => file.synthetic);
  }
}
