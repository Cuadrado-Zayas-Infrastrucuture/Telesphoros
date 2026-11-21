import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneModifierListFile } from '@telesphoros/cpic-schema';
import { loadGeneModifiers } from './gene-modifier-loader';
import { KnowledgeLoadError, loadKnowledge } from './knowledge-loader';
import { contentSha256 } from './content-hash';
import type { SignerKeys } from './signatures';
import {
  cleanupTempDirs,
  copyOf,
  MODIFIER_TEST_IDS,
  signedModifierCopy,
  SYNTHETIC_DIR,
  SYNTHETIC_MODIFIERS_DIR as MODIFIERS_DIR,
  tempDir,
  TEST_SIGNER_KEYS,
  TEST_SIGNERS,
  UNLISTED_SIGNER,
  writeJson,
} from '../../../test/helpers/knowledge';

afterAll(cleanupTempDirs);

const NAMES = ['syn-modifiers-a.json', 'syn-modifiers-b.json'] as const;

const readList = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as GeneModifierListFile;

async function problemsOf(directory: string, mode: 'production' | 'non-production' = 'non-production', signerKeys: SignerKeys = TEST_SIGNER_KEYS): Promise<string[]> {
  try {
    await loadGeneModifiers({ directory, mode, signerKeys });
  } catch (error) {
    if (error instanceof KnowledgeLoadError) return [...error.problems];
    throw error;
  }
  return [];
}

/** Writes a third list into a copy of the fixtures, from the first list with these entries. */
async function withThirdList(entries: GeneModifierListFile['entries']): Promise<string> {
  const dir = await copyOf(MODIFIERS_DIR);
  const first = await readList(join(dir, NAMES[0]));
  await writeJson(join(dir, 'syn-modifiers-c.json'), { ...first, id: 'syn-modifiers-c', entries });
  return dir;
}

const entry = (overrides: Partial<GeneModifierListFile['entries'][number]> = {}): GeneModifierListFile['entries'][number] => ({
  ingredient: 'drugq',
  rxcui: 'syn-rxcui-drugq',
  gene: 'GENEC',
  hgncId: 'syn-hgnc-genec',
  effect: 'inhibitor',
  strength: 'strong',
  locator: { table: 'Synthetic Table 4' },
  ...overrides,
});

describe('loadGeneModifiers: the fixtures (spec 045 N1)', () => {
  it('loads the synthetic lists outside production, looked up by exact RxNorm id only', async () => {
    const set = await loadGeneModifiers({ directory: MODIFIERS_DIR, mode: 'non-production' });
    expect(set.mode).toBe('non-production');
    expect(set.files.map((file) => [file.path, file.id, file.synthetic, file.reviewStatus])).toEqual([
      ['syn-modifiers-a.json', 'syn-modifiers-a', true, 'unreviewed'],
      ['syn-modifiers-b.json', 'syn-modifiers-b', true, 'unreviewed'],
    ]);
    expect(set.containsSynthetic).toBe(true);
    expect(set.id).toMatch(/^[0-9a-f]{64}$/);
    // The fixture lists GENEB first; the set gives them in gene order.
    expect(set.modifiersOf('syn-rxcui-drugm')).toEqual([
      {
        ingredient: 'drugm',
        rxcui: 'syn-rxcui-drugm',
        gene: 'GENEA',
        hgncId: 'syn-hgnc-genea',
        effect: 'inhibitor',
        strength: 'strong',
        locator: { table: 'Synthetic Table 1', row: 'drugm' },
        listId: 'syn-modifiers-a',
        source: 'SYNTHETIC TEST FIXTURE - not FDA content',
        sourceUrl: 'https://example.invalid/synthetic',
        sourceVersion: 'synthetic-1',
      },
      expect.objectContaining({ gene: 'GENEB', effect: 'inhibitor', strength: 'moderate' }),
    ]);
    expect(set.modifiersOf('syn-rxcui-drugp')).toEqual([expect.objectContaining({ gene: 'GENEB', effect: 'inducer', strength: 'strong', listId: 'syn-modifiers-b' })]);
    const inducer = expect.objectContaining({ gene: 'GENEA', effect: 'inducer', strength: 'moderate', locator: { table: 'Synthetic Table 2' } });
    expect(set.modifiersOf('syn-rxcui-drugn')).toEqual([inducer]);
    // PN-3: a name, a near miss or an unlisted id finds nothing. Nothing here means "no modifier": the lists are not exhaustive (D8).
    for (const miss of ['drugm', 'syn-rxcui-drugm ', 'SYN-RXCUI-DRUGM', 'syn-rxcui-nope', '']) expect(set.modifiersOf(miss)).toEqual([]);
  });

  it('gives the same id every time, and a different id when any content changes', async () => {
    const first = await loadGeneModifiers({ directory: MODIFIERS_DIR, mode: 'non-production' });
    expect((await loadGeneModifiers({ directory: MODIFIERS_DIR, mode: 'non-production' })).id).toBe(first.id);
    const copy = await copyOf(MODIFIERS_DIR);
    const file = await readList(join(copy, NAMES[1]));
    file.entries[0]!.strength = 'moderate';
    await writeJson(join(copy, NAMES[1]), file);
    expect((await loadGeneModifiers({ directory: copy, mode: 'non-production' })).id).not.toBe(first.id);
  });

  it('hands out modifiers no caller can change', async () => {
    const set = await loadGeneModifiers({ directory: MODIFIERS_DIR, mode: 'non-production' });
    const list = set.modifiersOf('syn-rxcui-drugm');
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(Object.isFrozen(list[0]!.locator)).toBe(true);
  });
});

describe('loadGeneModifiers: the production rules (PN-1)', () => {
  it('refuses the synthetic, unreviewed fixtures', async () => {
    const problems = await problemsOf(MODIFIERS_DIR, 'production');
    for (const name of NAMES) {
      expect(problems).toContain(`${name}: synthetic test content is not allowed in production.`);
      expect(problems).toContain(`${name}: unreviewed content is not allowed in production.`);
    }
  });

  it('loads a list reviewed and signed by two configured signers, and records who signed', async () => {
    const set = await loadGeneModifiers({ directory: await signedModifierCopy(), mode: 'production', signerKeys: TEST_SIGNER_KEYS });
    expect(set.mode).toBe('production');
    expect(set.containsSynthetic).toBe(false);
    expect(set.files.map((file) => file.signedBy)).toEqual([
      ['test-signer-a', 'test-signer-b'],
      ['test-signer-a', 'test-signer-b'],
    ]);
    expect(set.modifiersOf(MODIFIER_TEST_IDS.rxcui.drugm).map((modifier) => [modifier.gene, modifier.hgncId])).toEqual([
      ['GENEA', MODIFIER_TEST_IDS.hgncId.GENEA],
      ['GENEB', MODIFIER_TEST_IDS.hgncId.GENEB],
    ]);
  });

  it('refuses one signer, an unlisted signer, and no configured keys', async () => {
    const one = await problemsOf(await signedModifierCopy({ signers: [TEST_SIGNERS[0]!] }), 'production');
    expect(one).toEqual(NAMES.map((name) => `${name}: needs valid signatures from 2 distinct signers; has 1.`));
    const unlisted = await problemsOf(await signedModifierCopy({ signers: [TEST_SIGNERS[0]!, UNLISTED_SIGNER] }), 'production');
    expect(unlisted).toEqual(NAMES.map((name) => `${name}: "test-signer-x" is not a configured signer.`));
    const none = await problemsOf(await signedModifierCopy(), 'production', new Map());
    expect(none).toEqual(NAMES.map((name) => `${name}: no signer keys are configured (KNOWLEDGE_SIGNER_KEYS), so its signatures cannot be checked.`));
  });

  it('refuses a list changed after it was signed', async () => {
    const dir = await signedModifierCopy();
    const file = await readList(join(dir, NAMES[0]));
    file.entries[0]!.strength = 'strong';
    file.entries[0]!.effect = 'inducer';
    await writeJson(join(dir, NAMES[0]), file);
    const problems = await problemsOf(dir, 'production');
    expect(problems).toContain(`${NAMES[0]}: the content changed after it was reviewed (hash mismatch). It must be reviewed again.`);
    expect(problems).toContain(`${NAMES[0]}: the signature by "test-signer-a" does not match this file's content.`);
  });

  it('gives the production rules to any mode that is not exactly "non-production"', async () => {
    expect(await problemsOf(MODIFIERS_DIR, 'prod' as never)).toContain(`${NAMES[0]}: synthetic test content is not allowed in production.`);
  });

  it('refuses a reviewed real list whose licence or origin is "unknown"', async () => {
    const edit = (file: GeneModifierListFile) => {
      file.origin = 'unknown';
    };
    const problems = await problemsOf(await signedModifierCopy({ edit }), 'production');
    expect(problems).toContain(`${NAMES[0]}: origin: A reviewed file must state the origin of its content (not "unknown").`);
  });
});

describe('loadGeneModifiers: what the directory may hold (every mode)', () => {
  it('refuses an empty directory, or one with only a README, rather than load "no modifier" by accident', async () => {
    expect(await problemsOf(await tempDir())).toEqual(['The gene modifier directory holds no list.']);
    const readme = await tempDir();
    await writeFile(join(readme, 'README.md'), 'Nothing yet.\n');
    expect(await problemsOf(readme)).toEqual(['The gene modifier directory holds no list.']);
  });

  it('refuses a directory it cannot read', async () => {
    const missing = join(await tempDir(), 'missing');
    expect(await problemsOf(missing)).toEqual([`The gene modifier directory cannot be read: ${missing}`]);
  });

  it('refuses a CPIC file, a folder, another file type and invalid JSON, naming each', async () => {
    const dir = await copyOf(MODIFIERS_DIR);
    await writeFile(join(dir, 'drugx-genea.json'), await readFile(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json')));
    await mkdir(join(dir, 'phenotypes'));
    await writeFile(join(dir, 'notes.txt'), 'x');
    await writeFile(join(dir, 'broken.json'), '{');
    expect(await problemsOf(dir)).toEqual([
      'broken.json: not valid JSON.',
      'drugx-genea.json: only gene modifier lists belong in this directory.',
      'notes.txt: only plain .json files are allowed here (no folders, links or other file types).',
      'phenotypes: only plain .json files are allowed here (no folders, links or other file types).',
    ]);
  });

  it('reports schema problems with their path, a name that is not the id, and a synthetic list marked reviewed', async () => {
    const dir = await copyOf(MODIFIERS_DIR);
    const first = await readList(join(dir, NAMES[0]));
    await writeJson(join(dir, NAMES[0]), { ...first, entries: [{ ...first.entries[0]!, strength: 'weak' }] });
    const second = await readList(join(dir, NAMES[1]));
    await writeJson(join(dir, 'renamed.json'), second);
    const reviewed = { status: 'reviewed', reviewedBy: 'Test Reviewer', reviewedAt: '2026-02-01', contentSha256: contentSha256(second) };
    await writeJson(join(dir, NAMES[1]), { ...second, review: reviewed });
    const problems = await problemsOf(dir);
    expect(problems.filter((p) => p.startsWith(`${NAMES[0]}:`))).toEqual([expect.stringMatching(/^syn-modifiers-a\.json: entries\.0\.strength: /)]);
    expect(problems).toContain('renamed.json: the file name must match its id (expected syn-modifiers-b.json).');
    expect(problems).toContain(`${NAMES[1]}: synthetic content can never be marked reviewed.`);
    expect(problems).toContain('syn-modifiers-b.json: id "syn-modifiers-b" is used by another file.');
  });

  it('loads a third list beside the others (control for the cross-file checks below)', async () => {
    const set = await loadGeneModifiers({ directory: await withThirdList([entry()]), mode: 'non-production' });
    expect(set.files).toHaveLength(3);
    expect(set.modifiersOf('syn-rxcui-drugq')).toEqual([expect.objectContaining({ gene: 'GENEC', listId: 'syn-modifiers-c' })]);
    expect(set.modifiersOf('syn-rxcui-drugm')).toHaveLength(2);
  });

  const sameAsFirst = entry({ ingredient: 'drugm', rxcui: 'syn-rxcui-drugm', gene: 'GENEA', hgncId: 'syn-hgnc-genea' });
  it.each([
    ['one ingredient and gene in two lists', sameAsFirst, 'both list drugm for GENEA.'],
    ['one RxNorm id under two names', entry({ rxcui: 'syn-rxcui-drugm' }), 'state the same RxNorm id for two ingredients.'],
    ['one gene with two HGNC ids', entry({ gene: 'GENEA', hgncId: 'syn-hgnc-other' }), 'state different HGNC ids for GENEA.'],
    ['one HGNC id for two genes', entry({ hgncId: 'syn-hgnc-genea' }), 'state the same HGNC id for two genes.'],
  ])('refuses %s, naming both files', async (_name, third, problem) => {
    expect(await problemsOf(await withThirdList([third]))).toEqual([`syn-modifiers-a.json and syn-modifiers-c.json ${problem}`]);
  });
});

describe('a gene modifier list is never CPIC knowledge (spec 045 D2)', () => {
  it('the CPIC loader refuses one by name, wherever it is put', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    // control: the copy loads before the list is added
    await expect(loadKnowledge({ directory: dir, mode: 'non-production' })).resolves.toBeDefined();
    for (const folder of ['phenotypes', 'guidelines']) await writeFile(join(dir, folder, NAMES[0]), await readFile(join(MODIFIERS_DIR, NAMES[0])));
    let problems: string[] = [];
    try {
      await loadKnowledge({ directory: dir, mode: 'non-production' });
    } catch (error) {
      if (!(error instanceof KnowledgeLoadError)) throw error;
      problems = [...error.problems];
    }
    expect(problems).toEqual([
      `guidelines/${NAMES[0]}: a gene modifier list never belongs in a CPIC knowledge directory; it loads from GENE_MODIFIERS_DIR.`,
      `phenotypes/${NAMES[0]}: a gene modifier list never belongs in a CPIC knowledge directory; it loads from GENE_MODIFIERS_DIR.`,
    ]);
  });
});
