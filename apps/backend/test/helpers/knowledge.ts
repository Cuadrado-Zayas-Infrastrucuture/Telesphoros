import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GuidelineFile, KnowledgeFile } from '@telesphoros/cpic-schema';
import { contentSha256 } from '../../src/services/knowledge/content-hash';
import { signingMessage, type SignerKeys } from '../../src/services/knowledge/signatures';

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

export interface TestSigner {
  keyId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}
const signer = (keyId: string): TestSigner => ({ keyId, ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) });
/** Two P-256 signers made for this test run only, and the trust list that names them. Nothing real signs with these. */
export const TEST_SIGNERS: readonly TestSigner[] = [signer('test-signer-a'), signer('test-signer-b')];
export const TEST_SIGNER_KEYS: SignerKeys = new Map(TEST_SIGNERS.map((s) => [s.keyId, s.publicKey]));
/** A signer that is in no trust list. */
export const UNLISTED_SIGNER: TestSigner = signer('test-signer-x');

export function signatureBy(by: TestSigner, fileId: string, hash: string) {
  return {
    keyId: by.keyId,
    algorithm: 'ecdsa-p256-sha256' as const,
    signature: sign('sha256', signingMessage(fileId, hash), { key: by.privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

/** PEM form of a trust list, as KNOWLEDGE_SIGNER_KEYS carries it. */
export const signerKeysJson = (signers: readonly TestSigner[] = TEST_SIGNERS) =>
  JSON.stringify(Object.fromEntries(signers.map((s) => [s.keyId, s.publicKey.export({ type: 'spki', format: 'pem' }).toString()])));

/** Every combination of the gene maps' phenotypes that a guideline has no cell for, in gene order. */
export function uncoveredCombinations(file: GuidelineFile, phenotypes: ReadonlyMap<string, readonly string[]>): Record<string, string>[] {
  const combinations = file.genes.reduce<Record<string, string>[]>(
    (partial, gene) => partial.flatMap((when) => (phenotypes.get(gene) ?? []).map((phenotype) => ({ ...when, [gene]: phenotype }))),
    [{}],
  );
  return combinations.filter((when) => !file.recommendations.some((row) => file.genes.every((gene) => row.when[gene] === when[gene])));
}

/**
 * A copy of the synthetic fixtures turned into properly SIGNED-OFF content: not synthetic, reviewed,
 * with a correct content hash. Used to prove the production path works. Never written to the repo.
 * Files are raised to schema 1.3, which production requires, unless `schema: '1.2'` asks for them as they are. A 1.3 copy is signed by
 * `signers` (both TEST_SIGNERS unless told otherwise), so a production load needs `signerKeys: TEST_SIGNER_KEYS` (audit CLIN-01).
 * Production refuses a guideline with a combination that has no cell (audit DATA-01), so each one the fixture leaves out is signed as not
 * covered, unless `coverage: 'as-written'` keeps the gaps (schema 1.2 cannot state the marker, so a 1.2 copy keeps them too).
 */
export async function reviewedCopyOf(
  source: string,
  edit?: (file: KnowledgeFile) => void,
  options: { schema?: '1.2' | '1.3'; signers?: readonly TestSigner[]; coverage?: 'marked' | 'as-written' } = {},
): Promise<string> {
  const dir = await copyOf(source);
  const phenotypes = new Map<string, readonly string[]>();
  for (const name of await readdir(join(dir, 'phenotypes'))) {
    const file = name.endsWith('.json') ? await readJson(join(dir, 'phenotypes', name)) : undefined;
    if (file?.kind === 'gene-phenotype-map') phenotypes.set(file.gene, file.phenotypes);
  }
  const markGaps = options.schema !== '1.2' && options.coverage !== 'as-written';
  for (const folder of ['phenotypes', 'guidelines']) {
    for (const name of await readdir(join(dir, folder))) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, folder, name);
      const file = await readJson(path);
      file.synthetic = false;
      if (options.schema !== '1.2') toSchema13(file);
      if (markGaps && file.kind === 'guideline') {
        const gaps = uncoveredCombinations(file, phenotypes);
        if (gaps.length > 0) file.notCovered = gaps.map((when) => ({ when, note: 'Test copy: not covered by this table.' }));
      }
      edit?.(file);
      const hash = contentSha256(file);
      const signers = options.schema === '1.2' ? [] : (options.signers ?? TEST_SIGNERS);
      file.review = {
        status: 'reviewed',
        reviewedBy: 'Test Reviewer',
        reviewedAt: '2026-02-01',
        contentSha256: hash,
        ...(signers.length > 0 ? { signatures: signers.map((s) => signatureBy(s, file.id, hash)) } : {}),
      };
      await writeJson(path, file);
    }
  }
  return dir;
}
