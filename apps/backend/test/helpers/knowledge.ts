import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { KnowledgeFile } from '@telesphoros/cpic-schema';
import { contentSha256 } from '../../src/services/knowledge/content-hash';

export const REPO_ROOT = resolve(__dirname, '../../../..');
/** Invented genes and drugs. Tests only. */
export const SYNTHETIC_DIR = join(REPO_ROOT, 'data/fixtures/knowledge/synthetic');
/** The real knowledge directory that ships. */
export const REAL_KNOWLEDGE_DIR = join(REPO_ROOT, 'knowledge/cpic');
export const SCENARIO_DIR = join(REPO_ROOT, 'tests/clinical_scenarios');

const created: string[] = [];

/** A scratch directory that `cleanupTempDirs` removes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Copies a knowledge directory so a test can break it. */
export async function copyOf(source: string): Promise<string> {
  const dir = await tempDir();
  await cp(source, dir, { recursive: true });
  return dir;
}

export async function readJson(path: string): Promise<KnowledgeFile> {
  return JSON.parse(await readFile(path, 'utf8')) as KnowledgeFile;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A copy of the synthetic fixtures turned into properly SIGNED-OFF content: not synthetic, reviewed,
 * with a correct content hash. Used to prove the production path works. Never written to the repo.
 */
export async function reviewedCopyOf(source: string, edit?: (file: KnowledgeFile) => void): Promise<string> {
  const dir = await copyOf(source);
  for (const folder of ['phenotypes', 'guidelines']) {
    for (const name of await readdir(join(dir, folder))) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, folder, name);
      const file = await readJson(path);
      file.synthetic = false;
      edit?.(file);
      file.review = { status: 'reviewed', reviewedBy: 'Test Reviewer', reviewedAt: '2026-02-01', contentSha256: contentSha256(file) };
      await writeJson(path, file);
    }
  }
  return dir;
}
