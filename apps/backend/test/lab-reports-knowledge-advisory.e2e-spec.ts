import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { LAB_KNOWLEDGE } from '../src/lab-reports/evaluations.service';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, TEST_KNOWLEDGE } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// What an earlier evaluation says once a second release of the guidelines is loaded (audit CLIN-02). The second app is a real restart with another KNOWLEDGE_DIR on the same
// database, as a release is. Synthetic data only; the knowledge is the repository's invented test-only set.
(usingPostgres() ? describe : describe.skip)('an evaluation after the guidelines change', () => {
  let db: EphemeralDatabase;
  let first: NestExpressApplication;
  let second: NestExpressApplication;
  let nextRelease: string;
  let lab: LabPipeline;
  let firstSet: string;
  let secondSet: string;
  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    Logger.overrideLogger(new ConsoleLogger({ logLevels: ['fatal'] }));
    nextRelease = mkdtempSync(join(tmpdir(), 'knowledge-next-'));
    cpSync(TEST_KNOWLEDGE, nextRelease, { recursive: true });
    const file = join(nextRelease, 'guidelines/drugq-cyp2c19.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), guidelineVersion: 'synthetic-2' }, null, 2));
    db = await createEphemeralDatabase();
    first = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    second = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, knowledgeDir: nextRelease });
    firstSet = first.get<KnowledgeSet>(LAB_KNOWLEDGE).id;
    secondSet = second.get<KnowledgeSet>(LAB_KNOWLEDGE).id;
  }, 90_000);
  beforeEach(() => {
    lab = new LabPipeline(first, db.adminUrl);
  });
  afterAll(async () => {
    await second.close();
    await first.close();
    await db.drop();
    rmSync(nextRelease, { recursive: true, force: true });
    Logger.overrideLogger(new ConsoleLogger());
  });

  async function evaluated(local = lab) {
    const clin = await local.person('clin', ['clinician']);
    const rev = await local.person('rev', ['reviewer']);
    const s = await local.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
    const body = { captureId: s.captureId, acceptanceId: s.acceptanceId };
    const e: Json = (await local.evaluate(clin, s.reportId, body).expect(201)).body;
    return { ...s, clin, rev, body, e };
  }
  const onSecond = () => new LabPipeline(second, db.adminUrl, lab.tenant);

  it('the two apps really loaded different releases', () => {
    expect(firstSet).not.toBe(secondSet);
  });

  it('reads same under the release that made it, and changed under the next, while staying current and active', async () => {
    const s = await evaluated();
    expect(s.e.advisory.knowledge).toEqual({ evaluatedWith: firstSet, loadedNow: firstSet, status: 'same' });

    const detail: Json = (await onSecond().api().get(`/api/v1/evaluations/${s.e.id}`).set(bearer(s.clin.token)).expect(200)).body;
    expect(detail.advisory.knowledge).toEqual({ evaluatedWith: firstSet, loadedNow: secondSet, status: 'changed' });
    expect(detail).toMatchObject({ id: s.e.id, current: true, state: 'active', knowledgeSetId: firstSet });

    const listed: Json = (await onSecond().api().get('/api/v1/evaluations?current=true').set(bearer(s.clin.token)).expect(200)).body;
    expect(listed.data.map((d: Json) => [d.id, d.advisory.knowledge.status])).toEqual([[s.e.id, 'changed']]);

    const again: Json = (await lab.api().get(`/api/v1/evaluations/${s.e.id}`).set(bearer(s.clin.token)).expect(200)).body;
    expect(again.advisory.knowledge.status).toBe('same'); // read-time only: nothing about the evaluation was changed
  });

  it('a new evaluation under the next release reads same', async () => {
    // The whole flow runs on the second app: each test app keeps its own object store, so it cannot read text the first one captured.
    const { e } = await evaluated(onSecond());
    expect(e.knowledgeSetId).toBe(secondSet);
    expect(e.advisory.knowledge).toEqual({ evaluatedWith: secondSet, loadedNow: secondSet, status: 'same' });
  });

  it('an evaluation made under a dispute overlay is not a change, though its stored set id differs', async () => {
    const s = await evaluated();
    const result = s.e.results.find((r: Json) => r.drug === 'drugq');
    const { guidelineId, locator } = result.citation;
    await lab
      .api()
      .post('/api/v1/cell-disputes')
      .set(bearer(s.rev.token))
      .send({ guidelineId, locator: { table: locator.table, row: locator.row, ...(locator.column ? { column: locator.column } : {}) }, note: 'SYN: x' })
      .expect(201);
    const overlaid: Json = (await lab.evaluate(s.clin, s.reportId, s.body).expect(201)).body;
    expect(overlaid.knowledgeSetId).not.toBe(firstSet);
    expect(overlaid.advisory.knowledge).toEqual({ evaluatedWith: firstSet, loadedNow: firstSet, status: 'same' });
  });
});
