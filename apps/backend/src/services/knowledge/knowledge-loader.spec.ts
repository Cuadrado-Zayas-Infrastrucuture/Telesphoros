import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KnowledgeLoadError, loadKnowledge } from './knowledge-loader';
import { cleanupTempDirs, copyOf, readJson, REAL_KNOWLEDGE_DIR, reviewedCopyOf, SYNTHETIC_DIR, tempDir, writeJson } from '../../../test/helpers/knowledge';
import { contentSha256 } from './content-hash';
import type { GuidelineFile } from '@telesphoros/cpic-schema';

afterAll(cleanupTempDirs);

async function problemsOf(directory: string, mode: 'production' | 'non-production' = 'non-production'): Promise<string[]> {
  try {
    await loadKnowledge({ directory, mode });
  } catch (error) {
    if (error instanceof KnowledgeLoadError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadKnowledge: the fixtures', () => {
  it('loads the synthetic fixtures outside production', async () => {
    const set = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
    expect(set.files).toHaveLength(11);
    expect(set.guidelineCount).toBe(6);
    expect(set.drugs()).toEqual(['drugv', 'drugw', 'drugx', 'drugy']);
    expect(set.gene('GENEA')?.gene).toBe('GENEA');
    expect(set.gene('NOPE')).toBeUndefined();
    expect(set.guidelinesForDrug('drugx').map((g) => g.genes.join('+'))).toEqual(['GENEA', 'GENEC']);
    expect(set.guidelinesForDrug('drugv').map((g) => g.genes.join('+'))).toEqual(['GENEA', 'GENEA+GENEE']);
    expect(set.guidelinesForDrug('nope')).toEqual([]);
    expect(set.containsSynthetic).toBe(true);
    expect(set.allReviewed).toBe(false);
    expect(set.isEmpty).toBe(false);
    expect(set.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same id every time, and a different id when any content changes', async () => {
    const first = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
    const second = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
    expect(second.id).toBe(first.id);

    const copy = await copyOf(SYNTHETIC_DIR);
    const path = join(copy, 'guidelines/drugx-genea.json');
    const file = (await readJson(path)) as GuidelineFile;
    file.recommendations[0]!.recommendationText = 'Changed.';
    await writeJson(path, file);
    expect((await loadKnowledge({ directory: copy, mode: 'non-production' })).id).not.toBe(first.id);
  });
});

describe('loadKnowledge: production rules', () => {
  it('refuses every synthetic and unreviewed file, naming each one', async () => {
    const problems = await problemsOf(SYNTHETIC_DIR, 'production');
    expect(problems.filter((p) => p.includes('synthetic test content is not allowed in production'))).toHaveLength(11);
    expect(problems.filter((p) => p.includes('unreviewed content is not allowed in production'))).toHaveLength(11);
  });

  it('fails closed when the mode is missing or misspelled', async () => {
    for (const mode of [undefined, 'prod', 'Non-Production', '']) {
      // Called directly (not through problemsOf) so `undefined` is not replaced by a default.
      const outcome = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: mode as never }).then(
        () => 'loaded',
        (error: unknown) => (error instanceof KnowledgeLoadError ? 'refused' : 'crashed'),
      );
      expect(`${String(mode)} -> ${outcome}`).toMatch(/-> refused$/);
    }
  });

  it('accepts properly signed-off, non-synthetic content', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR);
    const set = await loadKnowledge({ directory: dir, mode: 'production' });
    expect(set.mode).toBe('production');
    expect(set.allReviewed).toBe(true);
    expect(set.containsSynthetic).toBe(false);
  });

  it('rejects a reviewed file whose content was edited after the sign-off, in every mode', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR);
    const path = join(dir, 'guidelines/drugx-genea.json');
    const file = (await readJson(path)) as GuidelineFile;
    file.recommendations[0]!.recommendationText = 'Edited after review.';
    await writeJson(path, file);
    for (const mode of ['production', 'non-production'] as const) {
      const problems = await problemsOf(dir, mode);
      expect(`${mode}: ${problems.join('\n')}`).toContain('drugx-genea.json: the content changed after it was reviewed');
    }
  });

  it('does not treat reformatting as a change: key order and whitespace are not content', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR);
    const path = join(dir, 'guidelines/drugx-genea.json');
    const file = (await readJson(path)) as unknown as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(file).reverse());
    await writeFile(path, JSON.stringify(reversed));
    await expect(loadKnowledge({ directory: dir, mode: 'production' })).resolves.toBeDefined();
  });

  it('the sign-off hash the helper writes is exactly the content hash the loader checks', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR);
    const path = join(dir, 'phenotypes/genea.json');
    const file = await readJson(path);
    expect(file.review.status).toBe('reviewed');
    expect(file.review.status === 'reviewed' && file.review.contentSha256).toBe(contentSha256(file));
  });

  it('never accepts synthetic content as reviewed', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const path = join(dir, 'phenotypes/gened.json');
    const file = await readJson(path);
    file.review = { status: 'reviewed', reviewedBy: 'X', reviewedAt: '2026-02-01', contentSha256: contentSha256(file) };
    await writeJson(path, file);
    expect((await problemsOf(dir)).join('\n')).toContain('synthetic content can never be marked reviewed');
  });

  it('the knowledge directory that ships always loads under the production rules', async () => {
    // If someone commits unreviewed, edited or synthetic content under knowledge/cpic, this fails the build.
    const set = await loadKnowledge({ directory: REAL_KNOWLEDGE_DIR, mode: 'production' });
    expect(set.containsSynthetic).toBe(false);
    expect(set.allReviewed).toBe(true);
  });
});

describe('loadKnowledge: unrecognised things are errors, never skipped', () => {
  it.each([
    ['a stray file at the top', async (dir: string) => writeFile(join(dir, 'notes.txt'), 'x'), 'notes.txt: unexpected entry'],
    ['a misspelled folder', async (dir: string) => mkdir(join(dir, 'guidlines')), 'guidlines: unexpected entry'],
    ['a non-JSON file in a folder', async (dir: string) => writeFile(join(dir, 'guidelines/readme.txt'), 'x'), 'guidelines/readme.txt: only plain .json files'],
    ['a nested folder', async (dir: string) => mkdir(join(dir, 'guidelines/old')), 'guidelines/old: only plain .json files'],
    ['a JSON file in the reserved folder', async (dir: string) => writeFile(join(dir, 'gene-drug-pairs/x.json'), '{}'), 'reserved'],
    ['invalid JSON', async (dir: string) => writeFile(join(dir, 'guidelines/broken.json'), '{ nope'), 'broken.json: not valid JSON'],
  ])('%s', async (_name, change, expected) => {
    const dir = await copyOf(SYNTHETIC_DIR);
    await mkdir(join(dir, 'gene-drug-pairs'), { recursive: true });
    await change(dir);
    expect((await problemsOf(dir)).join('\n')).toContain(expected);
  });

  it('a symbolic link', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    await symlink(join(dir, 'guidelines/drugx-genea.json'), join(dir, 'guidelines/linked.json'));
    expect((await problemsOf(dir)).join('\n')).toContain('guidelines/linked.json: only plain .json files');
  });

  it('a file in the wrong folder, a file name that is not its id, and an oversized file', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    await writeJson(join(dir, 'phenotypes/drugx-genea.json'), await readJson(join(dir, 'guidelines/drugx-genea.json')));
    await writeJson(join(dir, 'guidelines/renamed.json'), await readJson(join(dir, 'guidelines/drugy-geneb.json')));
    await writeFile(join(dir, 'guidelines/big.json'), ' '.repeat(1024 * 1024 + 1));
    const text = (await problemsOf(dir)).join('\n');
    expect(text).toContain('a guideline file does not belong in this folder');
    expect(text).toContain('guidelines/renamed.json: the file name must match its id');
    expect(text).toContain('guidelines/big.json: larger than');
  });

  it('a directory that does not exist', async () => {
    expect((await problemsOf(join(await tempDir(), 'missing'))).join('\n')).toContain('cannot be read');
  });

  it('reports a schema violation with the file and field, and no file content', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const path = join(dir, 'guidelines/drugx-genea.json');
    const file = (await readJson(path)) as GuidelineFile;
    (file.recommendations[0] as { strength: string }).strength = 'SECRET-LOOKING-VALUE';
    await writeJson(path, file);
    const text = (await problemsOf(dir)).join('\n');
    expect(text).toContain('guidelines/drugx-genea.json: recommendations.0.strength');
    expect(text).not.toContain('SECRET-LOOKING-VALUE');
  });
});

describe('loadKnowledge: cross-file consistency', () => {
  it('rejects duplicate ids, a second map for one gene, and a second guideline for one drug and gene', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const map = await readJson(join(dir, 'phenotypes/genea.json'));
    await writeJson(join(dir, 'phenotypes/genea2.json'), { ...map, id: 'genea2' });
    const guideline = (await readJson(join(dir, 'guidelines/drugx-genea.json'))) as GuidelineFile;
    await writeJson(join(dir, 'guidelines/drugx-genea-again.json'), { ...guideline, id: 'drugx-genea-again' });
    await writeJson(join(dir, 'guidelines/drugy-geneb-dup.json'), { ...(await readJson(join(dir, 'guidelines/drugy-geneb.json'))), id: 'drugx-genea' });
    const text = (await problemsOf(dir)).join('\n');
    expect(text).toContain('gene GENEA already has a phenotype map');
    expect(text).toContain('there is already a guideline for drugx and GENEA');
    expect(text).toContain('id "drugx-genea" is used by another file');
  });

  it('rejects a guideline for a gene with no map, and a phenotype the map does not define', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const guideline = (await readJson(join(dir, 'guidelines/drugy-geneb.json'))) as GuidelineFile;
    const rowsFor = (gene: string) => guideline.recommendations.map((row) => ({ ...row, when: { [gene]: Object.values(row.when)[0]! } }));
    await writeJson(join(dir, 'guidelines/drugq-genez.json'), { ...guideline, id: 'drugq-genez', drug: 'drugq', genes: ['GENEZ'], recommendations: rowsFor('GENEZ') });
    const other = (await readJson(join(dir, 'guidelines/drugx-genea.json'))) as GuidelineFile;
    other.recommendations[0]!.when = { GENEA: 'Synthetic Ultra' };
    await writeJson(join(dir, 'guidelines/drugx-genea.json'), other);
    const text = (await problemsOf(dir)).join('\n');
    expect(text).toContain('no phenotype map exists for gene GENEZ');
    expect(text).toContain('phenotype "Synthetic Ultra" is not one of the phenotypes defined for GENEA');
  });

  it('a combined table must be read against a phenotype defined for EACH of its genes', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const path = join(dir, 'guidelines/drugv-genea-genee.json');
    const combined = (await readJson(path)) as GuidelineFile;
    combined.recommendations[0]!.when = { GENEA: 'Synthetic Normal', GENEE: 'Synthetic Ultra' };
    await writeJson(path, combined);
    expect((await problemsOf(dir)).join('\n')).toContain('phenotype "Synthetic Ultra" is not one of the phenotypes defined for GENEE');
  });

  it('reports every problem together, not only the first', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    await writeFile(join(dir, 'notes.txt'), 'x');
    await writeFile(join(dir, 'guidelines/broken.json'), '{');
    expect((await problemsOf(dir)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('loadKnowledge: an empty knowledge directory', () => {
  it('loads as an empty set, in production too, so the system can say "no guideline loaded"', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'guidelines'));
    await writeFile(join(dir, 'guidelines/.gitkeep'), '');
    const set = await loadKnowledge({ directory: dir, mode: 'production' });
    expect(set.isEmpty).toBe(true);
    expect(set.drugs()).toEqual([]);
  });
});

describe('loadKnowledge: a combined table replacing narrower ones (supersedes)', () => {
  const variant = async (change: (dir: string, combined: GuidelineFile) => Promise<void> | void) => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const path = join(dir, 'guidelines/drugv-genea-genee.json');
    const combined = (await readJson(path)) as GuidelineFile;
    await change(dir, combined);
    await writeJson(path, combined);
    return (await problemsOf(dir)).join('\n');
  };
  const extra = async (dir: string, id: string, fields: Partial<GuidelineFile>) => {
    const template = (await readJson(join(dir, 'guidelines/drugv-genea.json'))) as GuidelineFile;
    await writeJson(join(dir, `guidelines/${id}.json`), { ...template, id, ...fields });
  };

  it('is accepted as shipped in the fixtures', async () => {
    expect(await problemsOf(SYNTHETIC_DIR)).toEqual([]);
  });

  it('refuses to supersede something that is not loaded', async () => {
    expect(await variant((_dir, c) => void (c.supersedes = ['drugv-nothing']))).toContain('supersedes "drugv-nothing", which is not a loaded guideline');
  });

  it('refuses to supersede a guideline for a different drug', async () => {
    expect(await variant((_dir, c) => void (c.supersedes = ['drugw-genea']))).toContain('which is for a different drug');
  });

  it('refuses to supersede a guideline whose genes are not a smaller subset', async () => {
    const text = await variant(async (dir, c) => {
      await extra(dir, 'drugv-geneb', { genes: ['GENEB'], recommendations: [{ ...(await readJson(join(dir, 'guidelines/drugy-geneb.json')) as GuidelineFile).recommendations[0]!, when: { GENEB: 'Synthetic Low' } }] });
      c.supersedes = ['drugv-geneb'];
    });
    expect(text).toContain('whose genes are not a smaller subset');
  });

  it('refuses a chain: a superseded guideline may not itself supersede others', async () => {
    const text = await variant(async (dir) => {
      const row = { ...(await readJson(join(dir, 'guidelines/drugv-genea-genee.json')) as GuidelineFile).recommendations[0]!, when: { GENEA: 'Synthetic Normal', GENEC: 'Synthetic Alpha', GENEE: 'Synthetic Fast' } };
      await extra(dir, 'drugv-three-genes', { genes: ['GENEA', 'GENEC', 'GENEE'], supersedes: ['drugv-genea-genee'], recommendations: [row] });
    });
    expect(text).toContain('which itself supersedes others (chains are not allowed)');
  });

  it('refuses a guideline that two different tables both claim to replace', async () => {
    const text = await variant(async (dir) => {
      const row = { ...(await readJson(join(dir, 'guidelines/drugv-genea-genee.json')) as GuidelineFile).recommendations[0]!, when: { GENEA: 'Synthetic Normal', GENEC: 'Synthetic Alpha' } };
      await extra(dir, 'drugv-genea-genec', { genes: ['GENEA', 'GENEC'], supersedes: ['drugv-genea'], recommendations: [row] });
    });
    expect(text).toContain('is already superseded by');
  });

  it('two tables for the same drug and the same genes are refused whatever order the genes are listed in', async () => {
    const text = await variant(async (dir) => {
      const combined = (await readJson(join(dir, 'guidelines/drugv-genea-genee.json'))) as GuidelineFile;
      await writeJson(join(dir, 'guidelines/drugv-reordered.json'), { ...combined, id: 'drugv-reordered', genes: ['GENEE', 'GENEA'], supersedes: [] });
    });
    expect(text).toContain('there is already a guideline for drugv and GENEE + GENEA');
  });
});
