import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type DrugResult, type GeneInput } from '@telesphoros/cpic-schema';
import { CLINICAL_USE, evaluationDtoSchema, evaluationSummaryDtoSchema, PIPELINE_SCOPE } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { evaluate } from '../src/services/recommendation-engine/recommendation-engine';
import { loadKnowledge } from '../src/services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { REPORT_HOLD_MESSAGES, type ReportHoldCode } from '../src/services/report-adapter';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { bearer } from './helpers/tokens';
import { DOCUMENT_IDS, fixturePdf, fixtureText, LabPipeline, TEST_KNOWLEDGE, REPO_ROOT } from './helpers/lab-pipeline';

// The headline proof of slice 5B-3.2: each of the twelve development reports goes through the REAL stack over HTTP (presigned upload,
// complete, capture, decision by a second person, evaluation with the real reader, the adapter and the engine, stored with its ledger
// event), and the stored result is compared with the HAND-WRITTEN expectation (tests/report_adapter/golden.json), which is the oracle.
// Re-running the same engine on the stored inputs afterwards is only a persistence-consistency check (both could share a defect).
interface Golden {
  id: string;
  disposition: 'evaluated' | 'held';
  holdCode?: string;
  geneInputs?: GeneInput[];
  notes?: Array<string | null>;
  engine?: Record<string, { outcome: string; reasonCode?: string; strength?: string; recommendationText?: string }>;
}
const golden = (JSON.parse(readFileSync(join(REPO_ROOT, 'tests/report_adapter/golden.json'), 'utf8')) as { cases: Golden[] }).cases;

(usingPostgres() ? describe : describe.skip)('lab-report evaluation, D01 to D12, end to end', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let knowledge: KnowledgeSet;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
    knowledge = await loadKnowledge({ directory: TEST_KNOWLEDGE, mode: 'non-production' });
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  afterAll(async () => {
    await verifier.close();
    await app.close();
    await db.drop();
  });

  it('has a hand-written expectation for exactly D01 to D12', () => {
    expect(golden.map((c) => c.id)).toEqual(DOCUMENT_IDS);
  });

  describe.each(golden.map((c) => [c.id, c] as const))('%s', (id, expected) => {
    let response: Awaited<ReturnType<LabPipeline['evaluate']>>;
    let evaluationId: string;
    let setup: Awaited<ReturnType<LabPipeline['reviewedCapture']>>;
    beforeAll(async () => {
      setup = await lab.reviewedCapture(fixturePdf(id));
      response = await lab.evaluate(setup.clinician, setup.reportId, { captureId: setup.captureId, acceptanceId: setup.acceptanceId });
      evaluationId = response.body.id;
    }, 60_000);

    it('is stored as the hand-written expectation says (disposition, hold code or gene inputs, per-occurrence notes)', async () => {
      expect(response.status).toBe(201);
      expect(evaluationDtoSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.disposition).toBe(expected.disposition);
      const stored = (await lab.row<{ gene_inputs: GeneInput[]; occurrences: Array<{ note: string | null }>; hold_code: string | null }>(
        `SELECT gene_inputs, occurrences, hold_code FROM evaluations WHERE id = $1`, [evaluationId]))[0]!;
      if (expected.disposition === 'held') {
        expect(stored.hold_code).toBe(expected.holdCode);
        expect(response.body.holdCode).toBe(expected.holdCode);
        expect(response.body.hold).toEqual({ message: REPORT_HOLD_MESSAGES[expected.holdCode as ReportHoldCode], reviewerAction: expect.any(String) });
        expect(stored.gene_inputs).toEqual([]);
        expect(response.body.results).toEqual([]);
        return;
      }
      expect(stored.hold_code).toBeNull();
      // The hand-written expectation names genes and states; the source is checked beside it: stored, and shown in the detail.
      expect(stored.gene_inputs.map((input) => { const copy: Record<string, unknown> = { ...input }; delete copy.callSource; return copy; })).toEqual(expected.geneInputs);
      expect([...new Set(stored.gene_inputs.map((input) => input.callSource))]).toEqual(['lab-report']);
      expect(response.body.geneInputs).toEqual(stored.gene_inputs);
      expect(stored.occurrences.map((o) => o.note)).toEqual(expected.notes);
    });

    it('shows, for each test drug, the outcome, reason, strength and wording the expectation says', () => {
      if (expected.disposition === 'held') return;
      expect(response.body.results.map((r: { drug: string }) => r.drug)).toEqual(['drugq', 'drugr']);
      for (const result of response.body.results as Array<{ drug: string; outcome: string; reasonCode: string | null; strength: string | null; recommendationText: string | null }>) {
        const want = expected.engine![result.drug]!;
        expect({ outcome: result.outcome, reasonCode: result.reasonCode ?? undefined, strength: result.strength ?? undefined, recommendationText: result.recommendationText ?? undefined }).toEqual({
          outcome: want.outcome, reasonCode: want.reasonCode, strength: want.strength, recommendationText: want.recommendationText,
        });
      }
    });

    it('records what it relied on: the knowledge, the build, the scope, the recordings, the decision; and says it is not approved for clinical use', async () => {
      expect(response.body).toMatchObject({
        clinicalUse: CLINICAL_USE, scope: PIPELINE_SCOPE, actionable: false, state: 'active', engineVersion: 'test-build-1', knowledgeSetId: knowledge.id,
        captureId: setup.captureId, reportId: setup.reportId, acceptance: { id: setup.acceptanceId, decision: 'accepted', current: true }, advisory: { activeDisputes: 0 },
      });
      const binding = (await lab.row<{ binding: Record<string, unknown> }>(`SELECT binding FROM evaluations WHERE id = $1`, [evaluationId]))[0]!.binding;
      expect(binding).toMatchObject({ scope: PIPELINE_SCOPE, recordingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/), captureAcceptanceId: setup.acceptanceId, popplerVersion: '26.03.0' });
    });

    it('persistence-consistency (NOT the oracle): re-running the engine on the stored inputs gives the stored results', async () => {
      if (expected.disposition === 'held') return;
      const stored = (await lab.row<{ gene_inputs: GeneInput[] }>(`SELECT gene_inputs FROM evaluations WHERE id = $1`, [evaluationId]))[0]!.gene_inputs;
      const again = evaluate(knowledge, stored);
      const shape = (r: { drug: string; outcome: string; reasonCode?: string | null; strength?: string | null; recommendationText?: string | null }) =>
        ({ drug: r.drug, outcome: r.outcome, reasonCode: r.reasonCode ?? null, strength: r.strength ?? null, recommendationText: r.recommendationText ?? null });
      expect(response.body.results.map(shape)).toEqual((again.results as DrugResult[]).map((r) => shape(r as never)));
    });

    it('shows no text from the report', () => {
      const shown = JSON.stringify(response.body);
      for (const line of fixtureText(id).split('\n').map((l) => l.trim()).filter((l) => l.length > 12).slice(0, 8)) expect(shown).not.toContain(line);
      expect(shown).not.toMatch(/reports\/|storageKey|createdBy/);
    });
  });

  it('the tenant\'s ledger chain verifies after all twelve (every record has its event, in order, with nothing missing)', async () => {
    const result = await verifier.verify(lab.tenant, { mode: 'full' });
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.eventsChecked).toBeGreaterThanOrEqual(12 * 3); // a capture, a decision and an evaluation for each report
  });

  it('reads are open to every clinical role (and refused to an administrator and to a member with none), are tenant-scoped, and list without the engine inputs', async () => {
    const ids = (await lab.row<{ id: string; report_id: string }>(`SELECT id, report_id FROM evaluations WHERE tenant_id = $1 ORDER BY seq`, [lab.tenant]));
    expect(ids).toHaveLength(12);
    const noRole = await lab.person('r', []);
    await lab.api().get('/api/v1/evaluations').set(bearer(noRole.token)).expect(403); // finding I04
    await lab.api().get(`/api/v1/evaluations/${ids[0]!.id}`).set(bearer(noRole.token)).expect(403);
    const adminOnly = await lab.person('r', ['admin']);
    await lab.api().get('/api/v1/evaluations').set(bearer(adminOnly.token)).expect(403); // administration is not clinical access
    await lab.api().get(`/api/v1/evaluations/${ids[0]!.id}`).set(bearer(adminOnly.token)).expect(403);
    for (const roles of [['reader'], ['clinician'], ['reviewer'], ['admin', 'reader']]) {
      const who = await lab.person('r', roles);
      const list = await lab.api().get('/api/v1/evaluations').set(bearer(who.token)).expect(200);
      expect(list.body.data).toHaveLength(12);
      expect(list.body.meta).toEqual({ page: 1, pageSize: 20, total: 12, totalPages: 1 });
      expect(evaluationSummaryDtoSchema.safeParse(list.body.data[0]).success).toBe(true);
      expect(list.body.data[0]).not.toHaveProperty('geneInputs');
      const one = await lab.api().get(`/api/v1/evaluations/${ids[0]!.id}`).set(bearer(who.token)).expect(200);
      expect(one.body).toHaveProperty('geneInputs');
    }
    const filtered = await lab.api().get(`/api/v1/evaluations?reportId=${ids[3]!.report_id}`).set(bearer((await lab.person('r', ['reader'])).token)).expect(200);
    expect(filtered.body.data.map((e: { id: string }) => e.id)).toEqual([ids[3]!.id]);
    const stranger = await lab.person('m', ['clinician'], 'tenant-two');
    expect((await lab.api().get('/api/v1/evaluations').set(bearer(stranger.token)).expect(200)).body.data).toEqual([]);
    await lab.api().get(`/api/v1/evaluations/${ids[0]!.id}`).set(bearer(stranger.token)).expect(404);
    await lab.api().get('/api/v1/evaluations/not-a-uuid').set(bearer(stranger.token)).expect(400);
    await lab.api().get('/api/v1/evaluations?unknown=1').set(bearer(stranger.token)).expect(400);
  });

  it('pages evaluation summaries in stable order with exact filtered totals and strict bounds', async () => {
    const who = await lab.person('pagination-reader', ['reader']);
    const rows = await lab.row<{ id: string; report_id: string; patient_id: string }>('SELECT id, report_id, patient_id FROM evaluations WHERE tenant_id = $1 ORDER BY seq', [lab.tenant]);
    const get = (query: string) => lab.api().get(`/api/v1/evaluations?${query}`).set(bearer(who.token));
    const all: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await get(`page=${page}&pageSize=5`).expect(200);
      expect(res.body.meta).toEqual({ page, pageSize: 5, total: 12, totalPages: 3 });
      expect(res.body.data).toHaveLength(page === 3 ? 2 : 5);
      all.push(...res.body.data.map((e: { id: string }) => e.id));
    }
    expect(all).toEqual(rows.map((r) => r.id));
    const empty = await get('page=4&pageSize=5').expect(200);
    expect(empty.body).toEqual({ data: [], meta: { page: 4, pageSize: 5, total: 12, totalPages: 3 } });
    for (const filter of [`reportId=${rows[0]!.report_id}`, `patientId=${rows[0]!.patient_id}&current=true`]) {
      const filtered = await get(`${filter}&page=2&pageSize=1`).expect(200);
      expect(filtered.body).toEqual({ data: [], meta: { page: 2, pageSize: 1, total: 1, totalPages: 1 } });
    }
    await get('pageSize=100').expect(200);
    for (const bad of ['page=0', 'page=-1', 'page=1.5', 'pageSize=0', 'pageSize=101', 'page=9007199254740991&pageSize=100', 'page=1&page=2', 'pageSize=nope']) await get(bad).expect(400);
  });
});
