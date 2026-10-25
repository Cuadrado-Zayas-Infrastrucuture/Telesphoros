import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Guards the byte-identical import of the Codex hand-off (knowledge/lab-report-reader/v2-handoff, see ORIGIN.md).
const REPO_ROOT = resolve(__dirname, '../../../../..');
const IMPORT_DIR = join(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff');
const REPO_AUTHORED = new Set(['ORIGIN.md', 'origin-hashes.json', '.gitattributes']);

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const posix = (path: string) => path.split(sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const origin = JSON.parse(readFileSync(join(IMPORT_DIR, 'origin-hashes.json'), 'utf8')) as Record<string, { sha256: string; originalPath: string }>;
const onDisk = walk(IMPORT_DIR)
  .map((file) => posix(relative(IMPORT_DIR, file)))
  .filter((path) => !REPO_AUTHORED.has(path))
  .sort();

describe('the imported hand-off is byte-identical to what was reviewed', () => {
  it('lists exactly the files that are on disk: nothing added, nothing missing', () => {
    expect(Object.keys(origin).sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(100);
  });

  it('matches the recorded SHA-256 of every file', () => {
    const changed = Object.entries(origin)
      .filter(([path, entry]) => sha256(join(IMPORT_DIR, path)) !== entry.sha256)
      .map(([path]) => path);
    expect(changed).toEqual([]);
  });

  it('records a distinct original path for every file, and left the archived selector out', () => {
    const originals = Object.values(origin).map((entry) => entry.originalPath);
    expect(new Set(originals).size).toBe(originals.length);
    expect(originals.some((path) => path.includes('quarantined-selector'))).toBe(false);
    expect(onDisk.some((path) => path.includes('quarantined-selector'))).toBe(false);
  });

  it('is never rewritten by Git: line-ending conversion is switched off for the whole directory', () => {
    expect(readFileSync(join(IMPORT_DIR, '.gitattributes'), 'utf8').trim()).toBe('* -text');
    for (const sample of ['engine/engine.py', 'engine/registry.json', 'fixtures/captures/D01/report.txt', 'fixtures/captures/D01/source.pdf']) {
      const out = execFileSync('git', ['check-attr', 'text', '--', join(IMPORT_DIR, sample)], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(out.trim().endsWith('text: unset')).toBe(true);
    }
  });

  it('keeps no compiled bytecode or other run residue inside the imported engine directory', () => {
    expect(onDisk.filter((path) => /__pycache__|\.pyc$/.test(path))).toEqual([]);
  });
});

describe('the imported material is labelled and kept out of production code', () => {
  it('says TEST ONLY and records that the reviewer identity was not independently authenticated', () => {
    for (const file of [join(IMPORT_DIR, 'ORIGIN.md'), join(IMPORT_DIR, '../README.md')])
      expect(readFileSync(file, 'utf8')).toContain('TEST ONLY: not clinical content, not human-adjudicated');
    expect(readFileSync(join(IMPORT_DIR, 'ORIGIN.md'), 'utf8')).toContain('not independently authenticated');
  });

  it('is never read by non-test source: only specs may name the fixtures', () => {
    const roots = ['apps/backend/src', 'apps/frontend/src', 'packages', 'sidecars'].map((root) => join(REPO_ROOT, root));
    const offenders = roots
      .flatMap((root) => walk(root))
      .filter((file) => /\.(ts|tsx|js|mjs|cjs|py)$/.test(file) && !/node_modules|[\\/]dist[\\/]|\.spec\.|\.test\./.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes('v2-handoff/fixtures'))
      .map((file) => posix(relative(REPO_ROOT, file)));
    expect(offenders).toEqual([]);
  });
});
