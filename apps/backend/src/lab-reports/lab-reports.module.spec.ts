import { resolve } from 'node:path';
import type { Env } from '../config/env';
import { KnowledgeLoadError } from '../services/knowledge/knowledge-loader';
import { SignerKeysError } from '../services/knowledge/signatures';
import { ReaderNotApprovedError } from '../services/report-reader/report-reader';
import { cleanupTempDirs, reviewedCopyOf, tempDir } from '../../test/helpers/knowledge';
import { labKnowledgeFactory, labReaderFactory, syntheticKnowledgeFactory } from './lab-reports.module';

// loadEnv refuses the pipeline in production. These are the second line: had that refusal been bypassed (a wrong or missing NODE_ENV reaching
// a production start), the reader and the knowledge loader must apply their own production rules, which the module used to switch off.
const TEST_KNOWLEDGE = resolve(__dirname, '../../../../data/fixtures/knowledge/test-only-reader');
const envOf = (NODE_ENV: Env['NODE_ENV']) => ({ NODE_ENV, LAB_REPORT_PIPELINE: 'enabled', KNOWLEDGE_DIR: TEST_KNOWLEDGE }) as Env;

describe('the lab-report pipeline applies production rules when NODE_ENV is production', () => {
  it('the reader refuses production, before it looks for the engine', async () => {
    await expect(labReaderFactory(envOf('production'))).rejects.toBeInstanceOf(ReaderNotApprovedError);
  });

  it('the knowledge loader applies the production rules (test-only content is refused); non-production loads it (control)', async () => {
    await expect(labKnowledgeFactory(envOf('production'))).rejects.toBeInstanceOf(KnowledgeLoadError);
    await expect(labKnowledgeFactory(envOf('development'))).resolves.toBeDefined();
  });

  it('the pipeline refuses an empty knowledge set in production; outside production it loads (audit CLIN-14)', async () => {
    const empty = await tempDir();
    await expect(labKnowledgeFactory({ ...envOf('production'), KNOWLEDGE_DIR: empty })).rejects.toThrow('KNOWLEDGE_DIR holds no guideline: production needs at least one.');
    await expect(labKnowledgeFactory({ ...envOf('development'), KNOWLEDGE_DIR: empty })).resolves.toBeDefined();
  });

  it('refuses to start with signer keys it cannot read (audit CLIN-01)', async () => {
    await expect(labKnowledgeFactory({ ...envOf('production'), KNOWLEDGE_SIGNER_KEYS: '{' })).rejects.toBeInstanceOf(SignerKeysError);
  });

  it('builds neither when the pipeline is off', async () => {
    const off = { ...envOf('production'), LAB_REPORT_PIPELINE: 'disabled' } as Env;
    await expect(labReaderFactory(off)).resolves.toBeUndefined();
    await expect(labKnowledgeFactory(off)).resolves.toBeUndefined();
  });
});

// Spec 032 S3: the synthetic structured assessment loads its own knowledge under the non-production rules, so the factory itself makes sure nothing but
// synthetic content can be loaded that way. It is never the pipeline's knowledge.
describe('the synthetic knowledge of the structured assessment', () => {
  const SYNTHETIC_STRUCTURED = resolve(__dirname, '../../../../data/fixtures/knowledge/synthetic-structured');
  const switched = (over: Partial<Env> = {}) =>
    ({ NODE_ENV: 'production', LAB_REPORT_PIPELINE: 'disabled', SYNTHETIC_ASSESSMENT: 'enabled', SYNTHETIC_KNOWLEDGE_DIR: SYNTHETIC_STRUCTURED, ...over }) as Env;
  afterAll(cleanupTempDirs);

  it('is built only while the switch is on, even in production mode, and then holds the synthetic guidelines (control for each refusal below)', async () => {
    await expect(syntheticKnowledgeFactory(switched({ SYNTHETIC_ASSESSMENT: 'disabled' }))).resolves.toBeUndefined();
    const set = await syntheticKnowledgeFactory(switched());
    expect(
      set
        ?.allGuidelines()
        .map((g) => g.id)
        .sort(),
    ).toEqual(['drugq-genea', 'drugz-genea', 'drugz-genea-geneb']);
    expect(set?.files.every((f) => f.synthetic)).toBe(true);
  });

  it('refuses a directory that holds content which says it is not synthetic, which the non-production loader would otherwise accept', async () => {
    const real = await reviewedCopyOf(SYNTHETIC_STRUCTURED);
    // Loaded as it would be started: the loader itself accepts it outside production, so only the factory's own check can stop it.
    await expect(syntheticKnowledgeFactory(switched({ SYNTHETIC_KNOWLEDGE_DIR: real }))).rejects.toThrow(/synthetic knowledge only/);
  });

  it('refuses an empty directory, and the base directory of the pipeline is not what it reads', async () => {
    await expect(syntheticKnowledgeFactory(switched({ SYNTHETIC_KNOWLEDGE_DIR: await tempDir() }))).rejects.toThrow(/at least one guideline/);
    const set = await syntheticKnowledgeFactory(switched());
    expect(set?.files.some((f) => f.path.includes('drugv'))).toBe(false);
  });
});
