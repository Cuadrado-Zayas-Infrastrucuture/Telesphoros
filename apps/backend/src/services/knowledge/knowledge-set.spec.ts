import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneMapFile, GuidelineFile } from '@telesphoros/cpic-schema';
import { readJson, SYNTHETIC_DIR } from '../../../test/helpers/knowledge';
import { loadKnowledge } from './knowledge-loader';
import { KnowledgeSet } from './knowledge-set';

const CONFLICTS_DIR = join(SYNTHETIC_DIR, '../identifier-conflicts');
const MAP_SET_DIR = join(SYNTHETIC_DIR, '../identifier-map/set');

/** The files of a fixture folder, read as they are, for building a set without the loader (as the dispute overlay does). */
async function filesOf(directory: string): Promise<{ geneMaps: GeneMapFile[]; guidelines: GuidelineFile[] }> {
  const read = async (folder: string) =>
    Promise.all((await readdir(join(directory, folder))).filter((name) => name.endsWith('.json')).map((name) => readJson(join(directory, folder, name))));
  return {
    geneMaps: (await read('phenotypes')).filter((file): file is GeneMapFile => file.kind === 'gene-phenotype-map'),
    guidelines: (await read('guidelines')).filter((file): file is GuidelineFile => file.kind === 'guideline'),
  };
}

describe('KnowledgeSet: lookups by identifier (spec 039 IK-3)', () => {
  it('finds a drug by its RxNorm id and a gene by its HGNC id, and each id from its name', async () => {
    const set = await loadKnowledge({ directory: MAP_SET_DIR, mode: 'non-production' });
    expect(set.drugForRxcui('syn-rxcui-drugq')).toBe('drugq');
    expect(set.drugForRxcui('syn-rxcui-drugz')).toBe('drugz');
    expect(set.drugForRxcui('syn-rxcui-ingredient-r')).toBe('syn-rxcui-drugr');
    expect(set.rxcuiOfDrug('drugz')).toBe('syn-rxcui-drugz');
    expect(set.rxcuiOfDrug('syn-rxcui-drugr')).toBe('syn-rxcui-ingredient-r');
    expect(set.geneForHgnc('syn-hgnc-geneb')).toBe('GENEB');
    expect(set.hgncOfGene('GENEA')).toBe('syn-hgnc-genea');
  });

  it('matches exactly: no case folding, no trimming, and never a name for an id', async () => {
    const set = await loadKnowledge({ directory: MAP_SET_DIR, mode: 'non-production' });
    expect(set.drugForRxcui('SYN-RXCUI-DRUGQ')).toBeUndefined();
    expect(set.drugForRxcui(' syn-rxcui-drugq')).toBeUndefined();
    expect(set.drugForRxcui('syn-rxcui-drugq ')).toBeUndefined();
    // A drug whose name is spelled like an identifier is found by its id only.
    expect(set.drugForRxcui('syn-rxcui-drugr')).toBeUndefined();
    expect(set.drugForRxcui('drugq')).toBeUndefined();
    expect(set.rxcuiOfDrug('DRUGQ')).toBeUndefined();
    expect(set.rxcuiOfDrug('syn-rxcui-drugq')).toBeUndefined();
    expect(set.geneForHgnc('SYN-HGNC-GENEA')).toBeUndefined();
    expect(set.geneForHgnc('GENEA')).toBeUndefined();
    expect(set.hgncOfGene('genea')).toBeUndefined();
  });

  it('has nothing for an id or name it does not hold', async () => {
    const set = await loadKnowledge({ directory: MAP_SET_DIR, mode: 'non-production' });
    expect(set.drugForRxcui('syn-rxcui-unknown')).toBeUndefined();
    expect(set.drugForRxcui('990000000001')).toBeUndefined();
    expect(set.drugForRxcui('')).toBeUndefined();
    expect(set.rxcuiOfDrug('drugx')).toBeUndefined();
    expect(set.geneForHgnc('syn-hgnc-genez')).toBeUndefined();
    expect(set.hgncOfGene('GENEZ')).toBeUndefined();
    const empty = new KnowledgeSet('empty', 'non-production', [], [], []);
    expect([empty.drugForRxcui('syn-rxcui-drugq'), empty.rxcuiOfDrug('drugq'), empty.geneForHgnc('syn-hgnc-genea'), empty.hgncOfGene('GENEA')]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('knows one id for a drug in two files, and none for a drug or gene that only schema 1.2 files describe', async () => {
    const set = await loadKnowledge({ directory: join(CONFLICTS_DIR, 'control'), mode: 'non-production' });
    expect(set.drugForRxcui('syn-rxcui-drugq')).toBe('drugq');
    expect(set.rxcuiOfDrug('drugq')).toBe('syn-rxcui-drugq');
    expect(set.rxcuiOfDrug('drugs')).toBe('syn-rxcui-drugs');
    expect(set.rxcuiOfDrug('drugt')).toBeUndefined();
    expect(set.hgncOfGene('GENEC')).toBeUndefined();
    expect(set.hgncOfGene('GENEB')).toBe('syn-hgnc-geneb');
  });

  it('refuses to be built from files that break IK-1, as the dispute overlay could, naming no identifier', async () => {
    const refused: Record<string, string> = {
      'one-drug-two-ids': 'KnowledgeSet: drug "drugq" states two RxNorm ids.',
      'two-drugs-one-id': 'KnowledgeSet: drugs "drugq" and "drugr" state one RxNorm id.',
      'two-genes-one-id': 'KnowledgeSet: genes GENEA and GENEB state one HGNC id.',
    };
    for (const [name, message] of Object.entries(refused)) {
      const { geneMaps, guidelines } = await filesOf(join(CONFLICTS_DIR, name));
      expect(() => new KnowledgeSet('test', 'non-production', geneMaps, guidelines, [])).toThrow(message);
    }
    // Controls: the same constructor builds the control and the mapping set, and a set the loader built can be copied (the dispute overlay).
    for (const directory of [join(CONFLICTS_DIR, 'control'), MAP_SET_DIR]) {
      const { geneMaps, guidelines } = await filesOf(directory);
      expect(() => new KnowledgeSet('test', 'non-production', geneMaps, guidelines, [])).not.toThrow();
      const loaded = await loadKnowledge({ directory, mode: 'non-production' });
      const copy = new KnowledgeSet(loaded.id, loaded.mode, loaded.allGeneMaps(), loaded.allGuidelines(), loaded.files);
      expect(copy.drugs().map((drug) => copy.rxcuiOfDrug(drug))).toEqual(loaded.drugs().map((drug) => loaded.rxcuiOfDrug(drug)));
    }
  });
});
