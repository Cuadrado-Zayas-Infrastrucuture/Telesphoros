import { resolve } from 'node:path';
import type { Env } from '../config/env';
import { KnowledgeLoadError } from '../services/knowledge/knowledge-loader';
import { ReaderNotApprovedError } from '../services/report-reader/report-reader';
import { labKnowledgeFactory, labReaderFactory } from './lab-reports.module';

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

  it('builds neither when the pipeline is off', async () => {
    const off = { ...envOf('production'), LAB_REPORT_PIPELINE: 'disabled' } as Env;
    await expect(labReaderFactory(off)).resolves.toBeUndefined();
    await expect(labKnowledgeFactory(off)).resolves.toBeUndefined();
  });
});
