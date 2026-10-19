import { join } from 'node:path';
import { contentSha256 } from './content-hash';
import { runKnowledgeCli } from './cli';
import { cleanupTempDirs, readJson, REAL_KNOWLEDGE_DIR, SYNTHETIC_DIR, tempDir } from '../../../test/helpers/knowledge';
import { writeFile } from 'node:fs/promises';

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

  it('verify passes for the knowledge directory that ships, in production, and says when it is empty', async () => {
    const result = await run(['verify', '--production'], { KNOWLEDGE_DIR: REAL_KNOWLEDGE_DIR });
    expect(result.code).toBe(0);
    expect(result.text).toContain('no guidelines are loaded');
  });

  it('hash prints exactly the hash the loader checks', async () => {
    const path = join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json');
    const result = await run(['hash', path]);
    expect(result).toEqual({ code: 0, text: contentSha256(await readJson(path)) });
  });

  it('hash refuses to prepare a signature for real content whose license or redistribution is "unknown"', async () => {
    const dir = await tempDir();
    const source = (await readJson(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json'))) as unknown as { synthetic: boolean; provenance: Record<string, string> };
    for (const [field, value] of [['license', 'cc0-1.0'], ['redistribution', 'allowed']] as const) {
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
