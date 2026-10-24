import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanupTempDirs, copyOf, readJson, reviewedCopyOf, SYNTHETIC_DIR, tempDir, writeJson } from '../../../test/helpers/knowledge';
import { runKnowledgeCli } from './cli';
import { knowledgeSetId } from './content-hash';
import { loadKnowledge } from './knowledge-loader';
import { locateKnowledgeSet } from './knowledge-locate';

jest.setTimeout(120_000);
afterAll(cleanupTempDirs);

const sh = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await sh('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function newRepo(): Promise<string> {
  const repo = await tempDir();
  await git(repo, 'init', '-q');
  return repo;
}

/** Replaces knowledge/cpic with a copy of `source` and commits it. Returns the commit. */
async function commitKnowledge(repo: string, source: string, subject: string): Promise<string> {
  const target = join(repo, 'knowledge/cpic');
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

const idOf = async (directory: string) => (await loadKnowledge({ directory, mode: 'non-production' })).id;

async function locate(repo: string, id: string, ...extra: string[]) {
  const lines: string[] = [];
  const code = await runKnowledgeCli(['locate', id, '--repo', repo, ...extra], (line) => lines.push(line));
  return { code, text: lines.join('\n'), lines };
}

describe('knowledge locate', () => {
  it('finds the commit that holds a set, and only that commit', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const setB = await reviewedCopyOf(SYNTHETIC_DIR, (file) => {
      file.provenance.retrievedAt = '2026-03-03';
    });
    const [idA, idB] = [await idOf(setA), await idOf(setB)];
    expect(idA).not.toBe(idB);

    const repo = await newRepo();
    const a = await commitKnowledge(repo, setA, 'knowledge set A');
    const b = await commitKnowledge(repo, setB, 'knowledge set B');
    await writeFile(join(repo, 'unrelated.txt'), 'not knowledge');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'unrelated change');

    const foundA = await locate(repo, idA);
    expect(foundA.code).toBe(0);
    expect(foundA.lines).toHaveLength(1);
    expect(foundA.lines[0]).toMatch(new RegExp(`^FOUND ${a} \\S+ knowledge set A$`));
    const foundB = await locate(repo, idB);
    expect([foundB.code, foundB.lines[0]?.startsWith(`FOUND ${b} `)]).toEqual([0, true]);
  });

  it('prints a commit subject with control characters replaced, so a hostile subject cannot rewrite the terminal', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const repo = await newRepo();
    await commitKnowledge(repo, setA, `set A\u001b[31m red\u0007 bell ${'x'.repeat(200)}`);
    const result = await locate(repo, await idOf(setA));
    expect(result.code).toBe(0);
    const line = result.lines[0] ?? '';
    expect(line).toContain('set A [31m red  bell');
    // eslint-disable-next-line no-control-regex -- the point of the assertion is that none of these characters remain
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    // FOUND <commit> <date> <subject>: the subject is everything after the third space
    expect(line.split(' ').slice(3).join(' ').length).toBeLessThanOrEqual(100);
  });

  it('lists every commit when the same content comes back, newest first', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const setB = await reviewedCopyOf(SYNTHETIC_DIR, (file) => {
      file.provenance.retrievedAt = '2026-03-03';
    });
    const repo = await newRepo();
    const a = await commitKnowledge(repo, setA, 'A');
    await commitKnowledge(repo, setB, 'B');
    const again = await commitKnowledge(repo, setA, 'A again');
    const result = await locate(repo, await idOf(setA));
    expect(result.code).toBe(0);
    expect(result.lines.map((line) => line.split(' ')[1])).toEqual([again, a]);
  });

  it('does not find an id made from content that was never committed, and still finds the real one (control)', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const neverCommitted = await reviewedCopyOf(SYNTHETIC_DIR, (file) => {
      file.provenance.retrievedAt = '2026-04-04';
    });
    const repo = await newRepo();
    await commitKnowledge(repo, setA, 'A');
    const missing = await locate(repo, await idOf(neverCommitted));
    expect(missing.code).toBe(1);
    expect(missing.text).toMatch(/^NOT FOUND: none of the 1 commits examined has knowledge set [0-9a-f]{64} \(0 did not load as a set\)\.$/);
    expect((await locate(repo, await idOf(setA))).code).toBe(0);
  });

  it('a commit whose file was edited after review does not load, so it is never reported as the set', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const idA = await idOf(setA);
    const repo = await newRepo();
    const a = await commitKnowledge(repo, setA, 'A');
    const tampered = await copyOf(setA);
    const file = join(tampered, 'guidelines', (await readdir(join(tampered, 'guidelines'))).find((name) => name.endsWith('.json')) ?? '');
    const content = await readJson(file);
    // content changes, the sign-off is left as it was: the loader must call this edited after review
    await writeJson(file, { ...content, provenance: { ...content.provenance, retrievedAt: '2026-05-05' } });
    await commitKnowledge(repo, tampered, 'edited after review');
    const result = await locate(repo, idA);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.startsWith(`FOUND ${a} `)).toBe(true);
    const asked = await locateKnowledgeSet({ repo, directory: 'knowledge/cpic', id: idA, mode: 'non-production', limit: 10, allRefs: false });
    expect([asked.examined, asked.unloadable]).toEqual([2, 1]);
  });

  it('--production refuses synthetic content; without it the same commit is found', async () => {
    const repo = await newRepo();
    const commit = await commitKnowledge(repo, SYNTHETIC_DIR, 'synthetic');
    const id = await idOf(SYNTHETIC_DIR);
    const relaxed = await locate(repo, id);
    expect([relaxed.code, relaxed.lines[0]?.startsWith(`FOUND ${commit} `)]).toEqual([0, true]);
    const strict = await locate(repo, id, '--production');
    expect(strict.code).toBe(1);
    expect(strict.text).toContain('(1 did not load as a set)');
  });

  it('the empty knowledge directory (placeholders only) has the id of an empty set', async () => {
    const empty = await tempDir();
    await mkdir(join(empty, 'guidelines'));
    await writeFile(join(empty, 'guidelines', '.gitkeep'), '');
    const repo = await newRepo();
    const commit = await commitKnowledge(repo, empty, 'placeholders only');
    const result = await locate(repo, knowledgeSetId([]));
    expect([result.code, result.lines[0]?.startsWith(`FOUND ${commit} `)]).toEqual([0, true]);
  });

  it('a commit that removed the directory, or put a link in it, counts as not loading', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const repo = await newRepo();
    const a = await commitKnowledge(repo, setA, 'A');
    // README.md is a file name the loader ignores when it is a plain file but refuses when it is a link, so a commit that
    // treated this link as a plain file would load to the SAME id as A and be reported as a match
    await rm(join(repo, 'knowledge/cpic/guidelines/README.md'), { force: true });
    await symlink('/etc/hosts', join(repo, 'knowledge/cpic/guidelines/README.md'));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'adds a link');
    await rm(join(repo, 'knowledge'), { recursive: true, force: true });
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'removes the directory');
    const result = await locateKnowledgeSet({ repo, directory: 'knowledge/cpic', id: await idOf(setA), mode: 'non-production', limit: 10, allRefs: false });
    expect(result.matches.map((m) => m.commit)).toEqual([a]);
    expect([result.examined, result.unloadable]).toEqual([3, 2]);
  });

  it('says so when --limit cut the search short', async () => {
    const setA = await reviewedCopyOf(SYNTHETIC_DIR);
    const setB = await reviewedCopyOf(SYNTHETIC_DIR, (file) => {
      file.provenance.retrievedAt = '2026-03-03';
    });
    const repo = await newRepo();
    await commitKnowledge(repo, setA, 'A');
    await commitKnowledge(repo, setB, 'B');
    const result = await locate(repo, await idOf(setA), '--limit', '1');
    expect(result.code).toBe(1);
    expect(result.text).toContain('only the newest 1 commits');
    expect((await locate(repo, await idOf(setA), '--limit', '2')).code).toBe(0);
  });

  it('refuses bad input without a stack trace or a path from the machine', async () => {
    const repo = await newRepo();
    expect((await locate(repo, 'not-an-id')).code).toBe(2);
    expect((await locate(repo, 'a'.repeat(64), '--limit', '0')).code).toBe(2);
    for (const extra of [['--dir', '../elsewhere'], ['--dir', '/etc'], ['--dir', 'a//b']]) {
      const refused = await locate(repo, 'a'.repeat(64), ...extra);
      expect([extra.join(' '), refused.code]).toEqual([extra.join(' '), 1]);
      expect(refused.text).not.toMatch(/\bat \S+:\d+|ENOENT|Error:|\/etc/);
    }
    const nowhere = await runKnowledgeCli(['locate', 'a'.repeat(64), '--repo', join(repo, 'missing')], () => undefined);
    expect(nowhere).toBe(1);
  });
});
