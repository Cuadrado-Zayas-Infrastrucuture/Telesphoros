import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { KnowledgeLoadError, loadKnowledge, type KnowledgeMode } from './knowledge-loader';

const run = promisify(execFile);
const GIT_BUFFER = 16 * 1024 * 1024;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

export const KNOWLEDGE_SET_ID = /^[0-9a-f]{64}$/;

export interface LocateOptions {
  /** Any path inside the git working tree. */
  repo: string;
  /** The knowledge directory relative to the repository root, e.g. knowledge/cpic. */
  directory: string;
  id: string;
  /** Production also requires every file in that commit to be reviewed and not synthetic. */
  mode: KnowledgeMode;
  /** Most commits examined; the newest come first. */
  limit: number;
  /** Search every ref, not only HEAD, so commits dropped by a rewrite are still found while they exist. */
  allRefs: boolean;
}

export interface LocateMatch {
  commit: string;
  date: string;
  subject: string;
}

export interface LocateResult {
  matches: LocateMatch[];
  examined: number;
  /** Commits whose knowledge directory is missing or would not load under the chosen mode. */
  unloadable: number;
  truncated: boolean;
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args], { maxBuffer: GIT_BUFFER, encoding: 'utf8' });
  return stdout;
}

/** A relative path with no `..`, no empty segment and no NUL, so it cannot name anything outside the repository. */
export function safeRelativeDirectory(value: string): string | undefined {
  const cleaned = value.replace(/\/+$/, '');
  if (!cleaned || cleaned.includes('\0') || isAbsolute(cleaned) || cleaned.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return cleaned;
}

/** Writes the knowledge directory exactly as one commit holds it. A link or submodule is not a plain file, so the commit does not load. */
async function materialise(root: string, commit: string, directory: string, into: string): Promise<void> {
  const listing = await git(root, ['ls-tree', '-r', '-z', commit, '--', directory]);
  for (const record of listing.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const mode = record.slice(0, record.indexOf(' '));
    const path = record.slice(tab + 1);
    if (!REGULAR_FILE_MODES.has(mode)) throw new KnowledgeLoadError([`${path}: not a plain file in this commit.`]);
    const relative = posix.relative(directory, path);
    if (relative.startsWith('..') || isAbsolute(relative)) continue;
    const target = join(into, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await git(root, ['show', `${commit}:${path}`]));
  }
}

/**
 * Finds the commits whose knowledge directory loads to the given knowledge set id, using the same loader the API uses,
 * so the answer cannot drift from how the id is made. An evaluation stores only the id; this is how a reviewer gets
 * back to the files it was computed from. It reads git only, prints no file content and changes nothing.
 */
export async function locateKnowledgeSet(options: LocateOptions): Promise<LocateResult> {
  const directory = safeRelativeDirectory(options.directory);
  if (!directory) throw new Error('directory');
  const root = (await git(options.repo, ['rev-parse', '--show-toplevel'])).trim();
  const listed = await git(root, ['log', `--max-count=${options.limit + 1}`, '--format=%H%x1f%cI%x1f%s', options.allRefs ? '--all' : 'HEAD', '--', directory]);
  const commits = listed
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit = '', date = '', subject = ''] = line.split('\x1f');
      return {
        commit,
        date,
        subject: [...subject]
          .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
          .join('')
          .slice(0, 100),
      };
    });
  const truncated = commits.length > options.limit;
  const examined = commits.slice(0, options.limit);

  const byTree = new Map<string, string | null>();
  const matches: LocateMatch[] = [];
  let unloadable = 0;
  for (const entry of examined) {
    let tree: string;
    try {
      tree = (await git(root, ['rev-parse', '--verify', '--quiet', `${entry.commit}:${directory}`])).trim();
    } catch {
      // intentional: the directory does not exist in this commit, which is not a set the API could have loaded
      unloadable++;
      continue;
    }
    if (!byTree.has(tree)) {
      const scratch = await mkdtemp(join(tmpdir(), 'knowledge-locate-'));
      try {
        await materialise(root, entry.commit, directory, scratch);
        byTree.set(tree, (await loadKnowledge({ directory: scratch, mode: options.mode })).id);
      } catch (error) {
        if (!(error instanceof KnowledgeLoadError)) throw error;
        byTree.set(tree, null);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    const id = byTree.get(tree);
    if (id === null) unloadable++;
    else if (id === options.id) matches.push(entry);
  }
  return { matches, examined: examined.length, unloadable, truncated };
}
