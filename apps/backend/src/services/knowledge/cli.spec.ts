import { join } from 'node:path';
import { contentSha256 } from './content-hash';
import { runKnowledgeCli } from './cli';
import { cleanupTempDirs, copyOf, readJson, REAL_KNOWLEDGE_DIR, SYNTHETIC_DIR, tempDir, writeJson } from '../../../test/helpers/knowledge';
import type { GuidelineFile } from '@telesphoros/cpic-schema';
import { rm, writeFile } from 'node:fs/promises';

afterAll(cleanupTempDirs);

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const code = await runKnowledgeCli(args, (line) => lines.push(line), env);
  return { code, text: lines.join('\n') };
}

describe('knowledge CLI', () => {
  it('verify passes for the fixtures outside production, and fails for them in production', async () => {
    const ok = await run(['verify', '--dir', SYNTHETIC_DIR]);
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/^OK \(non-production\): 11 files, 6 guidelines, knowledge set [0-9a-f]{64}/);
    const refused = await run(['verify', '--dir', SYNTHETIC_DIR, '--production']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('not allowed in production');
  });

  it('verify refuses an empty set in production unless --allow-empty says so on purpose (audit CLIN-14)', async () => {
    const refused = await run(['verify', '--production'], { KNOWLEDGE_DIR: REAL_KNOWLEDGE_DIR });
    expect(refused).toEqual({ code: 1, text: 'Refused: no guidelines are loaded. Production needs at least one; pass --allow-empty to accept an empty set on purpose.' });
    const allowed = await run(['verify', '--production', '--allow-empty'], { KNOWLEDGE_DIR: REAL_KNOWLEDGE_DIR });
    expect(allowed.code).toBe(0);
    expect(allowed.text).toContain('no guidelines are loaded');
    // control: outside production an empty set is only a note
    expect((await run(['verify'], { KNOWLEDGE_DIR: REAL_KNOWLEDGE_DIR })).code).toBe(0);
  });

  it('hash prints exactly the hash the loader checks', async () => {
    const path = join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json');
    const result = await run(['hash', path]);
    expect(result).toEqual({ code: 0, text: contentSha256(await readJson(path)) });
  });

  it('hash refuses to prepare a signature for real content whose license or redistribution is "unknown"', async () => {
    const dir = await tempDir();
    const source = (await readJson(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json'))) as unknown as { synthetic: boolean; provenance: Record<string, string> };
    for (const [field, value] of [
      ['license', 'cc0-1.0'],
      ['redistribution', 'allowed'],
    ] as const) {
      const real = { ...source, synthetic: false, provenance: { ...source.provenance, license: 'cc0-1.0', redistribution: 'allowed', [field]: 'unknown' } };
      const path = join(dir, `${field}.json`);
      await writeFile(path, JSON.stringify(real));
      const refused = await run(['hash', path]);
      expect([field, refused.code]).toEqual([field, 1]);
      expect(refused.text).toContain('Not ready to sign');
      expect(refused.text).not.toMatch(/^[0-9a-f]{64}$/);
      // control: stating the value makes the same file hashable
      await writeFile(path, JSON.stringify({ ...real, provenance: { ...real.provenance, [field]: value } }));
      expect([`${field} stated`, (await run(['hash', path])).code]).toEqual([`${field} stated`, 0]);
    }
  });

  it('hash still prints a hash for synthetic content with "unknown" fields (it can never be signed)', async () => {
    const dir = await tempDir();
    const source = (await readJson(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json'))) as unknown as { provenance: Record<string, string> };
    const path = join(dir, 'synthetic.json');
    await writeFile(path, JSON.stringify({ ...source, provenance: { ...source.provenance, license: 'unknown', redistribution: 'unknown' } }));
    expect((await run(['hash', path])).code).toBe(0);
  });

  it('hash refuses a file that is not a knowledge file, and reports a bad path without a stack trace', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'x.json'), '{"nope":true}');
    expect((await run(['hash', join(dir, 'x.json')])).code).toBe(1);
    const missing = await run(['hash', join(dir, 'missing.json')]);
    expect(missing.code).toBe(1);
    expect(missing.text).not.toMatch(/at |ENOENT|Error:/);
  });

  it('prints usage for anything else', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['sign'])).code).toBe(2);
    expect((await run(['hash'])).code).toBe(2);
  });
});

// Audit DATA-01: a source release that drops cells must not pass unnoticed. `diff OLD NEW` lists the combinations each guideline covers that were
// added or removed, and exits 1 when any coverage was lost.
describe('knowledge CLI: diff', () => {
  const edited = async (edit: (file: GuidelineFile) => void, id: string) => {
    const dir = await copyOf(SYNTHETIC_DIR);
    const path = join(dir, `guidelines/${id}.json`);
    const file = (await readJson(path)) as GuidelineFile;
    edit(file);
    await writeJson(path, file);
    return dir;
  };

  it('reports no change between a set and its copy', async () => {
    expect(await run(['diff', SYNTHETIC_DIR, await copyOf(SYNTHETIC_DIR)])).toEqual({ code: 0, text: 'No coverage change.' });
  });

  it('a release identical to its predecessor minus a cell is flagged: the lost combination is named and the exit is 1', async () => {
    const dropped = await edited((file) => {
      file.recommendations = file.recommendations.filter((row) => row.when.GENEA !== 'Synthetic Poor');
    }, 'drugx-genea');
    expect(await run(['diff', SYNTHETIC_DIR, dropped])).toEqual({
      code: 1,
      text: ['REMOVED drugx-genea: GENEA "Synthetic Poor"', 'Coverage lost: 1 combination in 1 guideline.'].join('\n'),
    });
  });

  it('an added cell is listed and is not a loss', async () => {
    const added = await edited((file) => {
      file.recommendations.push({ ...file.recommendations[0]!, when: { GENEB: 'Synthetic High' } });
    }, 'drugy-geneb');
    expect(await run(['diff', SYNTHETIC_DIR, added])).toEqual({ code: 0, text: 'ADDED drugy-geneb: GENEB "Synthetic High"' });
  });

  it('a guideline that disappears loses every combination it covered', async () => {
    const dir = await copyOf(SYNTHETIC_DIR);
    await rm(join(dir, 'guidelines/drugx-genec.json'));
    expect(await run(['diff', SYNTHETIC_DIR, dir])).toEqual({
      code: 1,
      text: ['REMOVED drugx-genec: GENEC "Synthetic Alpha"', 'REMOVED drugx-genec: GENEC "Synthetic Beta"', 'Coverage lost: 2 combinations in 1 guideline.'].join('\n'),
    });
  });

  it('refuses to compare a set that does not load, and names the side', async () => {
    const result = await run(['diff', SYNTHETIC_DIR, join(SYNTHETIC_DIR, 'missing')]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('NEW: The knowledge directory cannot be read');
    expect((await run(['diff', SYNTHETIC_DIR])).code).toBe(2);
  });
});
