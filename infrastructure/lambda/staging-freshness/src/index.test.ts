import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedFiles, realSources } from './index';

const APPLIED = 'a'.repeat(40);
const SHA = (n: number) => n.toString(16).padStart(40, '0');
const blob = (path: string, sha = SHA(1), mode = '100644') => ({ path, mode, type: 'blob', sha });
const dir = (path: string) => ({ path, mode: '040000', type: 'tree', sha: SHA(9) });

/** 340 docs files and 7 Terraform inputs changed after the applied commit: 347, as on 2026-11-25. The inputs sort after the first 300. */
const DOCS = Array.from({ length: 340 }, (_, i) => `docs/f${String(i).padStart(3, '0')}.md`);
const TF = Array.from({ length: 7 }, (_, i) => `infrastructure/terraform/z${i}.tf`);
const BEFORE = [dir('docs'), dir('infrastructure'), ...DOCS.map((p) => blob(p)), ...TF.map((p) => blob(p)), blob('apps/backend/src/a.ts')];
const AFTER = [dir('docs'), dir('infrastructure'), ...DOCS.map((p) => blob(p, SHA(2))), ...TF.map((p) => blob(p, SHA(2))), blob('apps/backend/src/a.ts')];

type Answers = Record<string, unknown>;
/** GitHub as the Lambda reads it: compare (which lists 300 changed files at most), both trees, and the commit lists. */
const github = (over: Answers = {}): Answers => ({
  [`compare/${APPLIED}...main`]: {
    status: 'ahead',
    files: [...DOCS, ...TF].slice(0, 300).map((filename) => ({ filename })),
    commits: [{ commit: { committer: { date: '2026-11-20T00:00:00Z' } } }],
  },
  [`git/trees/${APPLIED}?recursive=1`]: { truncated: false, tree: BEFORE },
  'git/trees/main?recursive=1': { truncated: false, tree: AFTER },
  [`commits/${APPLIED}`]: { commit: { committer: { date: '2026-11-19T00:00:00Z' } } },
  ...over,
});

let answers: Answers;
const asked: string[] = [];
beforeEach(() => {
  process.env.ECS_CLUSTER = 'c';
  process.env.API_SERVICE = 'a';
  process.env.WORKER_SERVICE = 'w';
  answers = github();
  asked.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace('https://api.github.com/repos/Cuadrado-Zayas-Infrastrucuture/Telesphoros/', '');
    asked.push(path);
    const known = path in answers ? answers[path] : path.startsWith('commits?') ? [] : undefined;
    if (known === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(known), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the files changed since the applied commit', () => {
  it('are all found when more than 300 changed, which GitHub compare cannot list', async () => {
    const r = await realSources().terraformFilesSince(APPLIED);
    expect(r).toEqual({ files: TF, truncated: false });
  });

  it('include a removed file and a file whose mode alone changed', () => {
    const files = changedFiles(
      [blob('infrastructure/terraform/gone.tf'), blob('scripts/x.sh'), blob('same.md')],
      [blob('scripts/x.sh', SHA(1), '100755'), blob('same.md'), blob('new.md')],
    );
    expect(files).toEqual(['infrastructure/terraform/gone.tf', 'new.md', 'scripts/x.sh']);
  });

  it('list both names of a renamed file, and never a directory', () => {
    expect(changedFiles([dir('infrastructure'), blob('infrastructure/terraform/old.tf')], [dir('infrastructure'), blob('infrastructure/terraform/new.tf')])).toEqual([
      'infrastructure/terraform/new.tf',
      'infrastructure/terraform/old.tf',
    ]);
  });

  it('are none when the trees match', async () => {
    answers['git/trees/main?recursive=1'] = { truncated: false, tree: BEFORE };
    expect(await realSources().terraformFilesSince(APPLIED)).toEqual({ files: [], truncated: false });
  });

  it('are reported truncated, never clean, when GitHub cuts a tree short', async () => {
    answers['git/trees/main?recursive=1'] = { truncated: true, tree: BEFORE };
    expect(await realSources().terraformFilesSince(APPLIED)).toEqual({ files: [], truncated: true });
  });

  it('are refused when the applied commit is not an ancestor of main', async () => {
    answers[`compare/${APPLIED}...main`] = { status: 'diverged', files: [], commits: [] };
    await expect(realSources().terraformFilesSince(APPLIED)).rejects.toThrow('applied commit is not an ancestor of main');
  });
});

describe('an application change since the image', () => {
  it('is found when more than 300 files changed, and dated by its path commits', async () => {
    answers['git/trees/main?recursive=1'] = { truncated: false, tree: [...AFTER.slice(0, -1), blob('apps/backend/src/a.ts', SHA(3))] };
    answers[`commits?sha=main&path=apps&since=${encodeURIComponent('2026-11-19T00:00:00Z')}&per_page=100`] = [
      { sha: SHA(5), commit: { committer: { date: '2026-11-21T00:00:00Z' } } },
    ];
    expect(await realSources().applicationChangeSince(APPLIED)).toEqual({ since: '2026-11-21T00:00:00Z' });
  });

  it('is none when only docs and Terraform changed', async () => {
    expect(await realSources().applicationChangeSince(APPLIED)).toEqual({ since: undefined });
  });

  it('is refused, never read as none, when GitHub cuts a tree short', async () => {
    answers[`git/trees/${APPLIED}?recursive=1`] = { truncated: true, tree: BEFORE };
    await expect(realSources().applicationChangeSince(APPLIED)).rejects.toThrow('tree truncated');
  });
});

describe('one run', () => {
  it('reads each commit pair from GitHub once, for both checks', async () => {
    const s = realSources();
    await s.terraformFilesSince(APPLIED);
    await s.applicationChangeSince(APPLIED);
    expect(asked.filter((p) => p.startsWith('compare/') || p.startsWith('git/trees/'))).toHaveLength(3);
  });
});
