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
 * Real-form identifiers for signed-off test copies. Each is beyond any range RxNorm, HGNC or PharmVar has assigned, so no test
 * names a real drug, gene or release. A non-synthetic file must use the real form (spec 033 D1).
 */
export const TEST_REAL_FORM_IDS = { rxcui: '999999999999', hgncId: 'HGNC:9999999', pharmvarVersion: '999.0.0' } as const;

/** Adds the schema 1.3 fields to a schema 1.2 file, with real-form test identifiers and origin "cpic". */
function toSchema13(file: KnowledgeFile): void {
  if (file.schemaVersion !== '1.2') return;
  file.schemaVersion = '1.3';
  if (file.kind === 'gene-phenotype-map') {
    file.hgncId = TEST_REAL_FORM_IDS.hgncId;
    file.origin = 'cpic';
    if (file.alleles !== undefined) file.pharmvarVersion = TEST_REAL_FORM_IDS.pharmvarVersion;
  } else {
    file.rxcui = TEST_REAL_FORM_IDS.rxcui;
    for (const row of file.recommendations) row.origin = 'cpic';
  }
}

/**
 * A copy of the synthetic fixtures turned into properly SIGNED-OFF content: not synthetic, reviewed,
 * with a correct content hash. Used to prove the production path works. Never written to the repo.
 * Files are raised to schema 1.3, which production requires, unless `schema: '1.2'` asks for them as they are.
 */
export async function reviewedCopyOf(source: string, edit?: (file: KnowledgeFile) => void, options: { schema?: '1.2' | '1.3' } = {}): Promise<string> {
  const dir = await copyOf(source);
  for (const folder of ['phenotypes', 'guidelines']) {
    for (const name of await readdir(join(dir, folder))) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, folder, name);
      const file = await readJson(path);
      file.synthetic = false;
      if (options.schema !== '1.2') toSchema13(file);
      edit?.(file);
      file.review = { status: 'reviewed', reviewedBy: 'Test Reviewer', reviewedAt: '2026-02-01', contentSha256: contentSha256(file) };
      await writeJson(path, file);
    }
  }
  return dir;
}
