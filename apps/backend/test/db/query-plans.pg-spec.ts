import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import { PostgresRecommendationsRepository } from '../../src/storage/postgres/recommendations.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

// A reproducible workload sample, not a load test or a latency CI threshold. Never force planner choices.
const tenants = ['syn-plans-a', 'syn-plans-b', 'syn-plans-c'];
const CORE_PATIENTS = 1500;
let pg: EphemeralDatabase;
let db: Database;
let patients: PostgresPatientsRepository;
let reports: PostgresReportsRepository;
let recommendations: PostgresRecommendationsRepository;
let ledger: PostgresLedgerRecordsRepository;
let selected: { patientId: string; reportId: string; recommendationId: string };
const histories: { reportId: string; patientId: string; captureId: string; evaluationIds: string[] }[] = [];
const evidence: Record<string, unknown>[] = [];

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  db = new Database({ url: pg.appUrl, ssl: 'disable' });
  patients = new PostgresPatientsRepository(db);
  reports = new PostgresReportsRepository(db);
  recommendations = new PostgresRecommendationsRepository(db);
  ledger = new PostgresLedgerRecordsRepository(db);
  await withAdmin(pg.adminUrl, async c => {
    for (const tenant of tenants) {
      await c.query(`INSERT INTO patients (tenant_id, created_by, label)
        SELECT $1, 'syn-author', 'SYN-' || g FROM generate_series(1,$2::int) g`, [tenant, CORE_PATIENTS]);
      await c.query(`INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes)
        SELECT $1, 'syn-author', p.id, 'vcf', 'syn.vcf', 100 FROM patients p CROSS JOIN generate_series(1,2) g WHERE p.tenant_id=$1`, [tenant]);
      await c.query(`INSERT INTO recommendations (tenant_id, created_by, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
        SELECT $1, 'syn-author', r.patient_id, r.id, 'G', 'syn-drug', 'syn-phenotype', 'Synthetic', 'Strong', 'syn-1' FROM reports r WHERE r.tenant_id=$1`, [tenant]);
    }
    selected = (await c.query(`SELECT r.patient_id AS "patientId", r.id AS "reportId", x.id AS "recommendationId"
      FROM reports r JOIN recommendations x ON x.report_id=r.id AND x.tenant_id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY r.seq LIMIT 1`, [tenants[0]])).rows[0];
  });
  for (const tenant of tenants) {
    for (const count of [60, 5]) {
      const report = await seedLabReport(pg.adminUrl, tenant);
      const captureInput = captureFor(report);
      const capture = await ledger.insertCapture(tenant, 'syn-uploader', captureInput);
      const accepted = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(capture.record.id, captureInput));
      const evaluationIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const evaluation = await ledger.insertEvaluation(tenant, 'syn-system', evaluationFor(report, capture.record.id, accepted.record.id, { knowledgeSetId: sha(`${i}`) }));
        evaluationIds.push(evaluation.record.id);
        if (i % 3 === 0) {
          const correction = await ledger.insertCorrection(tenant, 'syn-reviewer', { evaluationId: evaluation.record.id, kind: 'retraction', reasonCode: 'software-defect' });
          await ledger.insertCorrection(tenant, 'syn-independent', { evaluationId: evaluation.record.id, kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: correction.record.id });
        }
      }
      await ledger.insertAcceptance(tenant, 'syn-independent', acceptanceFor(capture.record.id, captureInput, { decision: 'rejected' }));
      if (tenant === tenants[0]) histories.push({ reportId: report.reportId, patientId: report.patientId, captureId: capture.record.id, evaluationIds });
    }
    for (let i = 0; i < 25; i++) {
      const dispute = await ledger.raiseDispute(tenant, 'syn-reviewer', { guidelineId: `syn-${i}`, guidelineVersion: '1', guidelineContentSha256: sha(`${i}`), locator: { table: '1', row: '1' }, note: 'Synthetic' });
      if (i % 2 === 0) await ledger.decideDispute(tenant, 'syn-independent', { disputeId: dispute.record.id, decision: 'upheld', evidenceNote: 'Synthetic' });
    }
  }
  await withAdmin(pg.adminUrl, async c => { await c.query('ANALYZE'); });
}, 60_000);
afterAll(async () => {
  try {
    if (process.env.QUERY_PLAN_OUTPUT && pg) {
      const facts = await withAdmin(pg.adminUrl, async c => ({
        postgres: (await c.query('SHOW server_version')).rows[0],
        databaseBytes: (await c.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes,
        rows: (await c.query(`SELECT 'patients' AS table_name, count(*)::int AS rows FROM patients UNION ALL SELECT 'reports', count(*)::int FROM reports
          UNION ALL SELECT 'recommendations', count(*)::int FROM recommendations UNION ALL SELECT 'evaluations', count(*)::int FROM evaluations
          UNION ALL SELECT 'corrections', count(*)::int FROM corrections UNION ALL SELECT 'capture_acceptances', count(*)::int FROM capture_acceptances
          UNION ALL SELECT 'cell_disputes', count(*)::int FROM cell_disputes UNION ALL SELECT 'ledger_events', count(*)::int FROM ledger_events`)).rows,
      }));
      writeFileSync(process.env.QUERY_PLAN_OUTPUT, JSON.stringify({ facts, role: 'restricted application', planning: 'unnamed parameterized statements; ANALYZE; no forced indexes', evidence }, null, 2));
    }
  } finally { await db?.onModuleDestroy(); await pg?.drop(); }
});

interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: PlanNode[] }
interface QueryPlan { Plan: PlanNode & { 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number }; 'Execution Time': number; 'Planning Time': number }
function nodes(plan: PlanNode): PlanNode[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }

async function measure<T>(label: string, work: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(Client.prototype, 'query'); // pass through: collect SQL actually executed by the real repositories
  let result: T;
  let statements: [string, unknown[]][];
  try {
    result = await work();
    statements = spy.mock.calls.flatMap(call => {
      const [text, values] = call as unknown as [unknown, unknown[]];
      return typeof text === 'string' && /^\s*(SELECT|WITH)\b/i.test(text) && !text.includes('set_config') ? [[text, values ?? []] as [string, unknown[]]] : [];
    });
  } finally { spy.mockRestore(); }
  expect(statements!.length).toBeGreaterThan(0);
  const plans = [];
  for (const [sql, parameters] of statements!) {
    const explained = await db.withTenant(tenants[0]!, c => c.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, parameters));
    const plan = explained.rows[0]['QUERY PLAN'][0] as QueryPlan;
    expect(plan['Execution Time']).toBeGreaterThanOrEqual(0);
    const walked = nodes(plan.Plan);
    plans.push({ sql, parameterTypes: parameters.map(p => p === null ? 'null' : Array.isArray(p) ? 'array' : typeof p),
      sqlSha256: createHash('sha256').update(sql).digest('hex'), ...plan,
      indexes: [...new Set(walked.flatMap(n => n['Index Name'] ? [n['Index Name']] : []))],
      scannedRows: walked.reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0),
    });
  }
  const summary = { label, statements: plans.length, executionMs: plans.reduce((sum,p) => sum + p['Execution Time'], 0),
    sharedHits: plans.reduce((sum,p) => sum + (p.Plan['Shared Hit Blocks'] ?? 0), 0),
    indexes: [...new Set(plans.flatMap(p => p.indexes))] };
  process.stdout.write(`Query-plan sample: ${JSON.stringify(summary)}\n`);
  evidence.push({ ...summary, plans });
  return result!;
}

it('measures real core list/count, filtered and parent/detail lookups with hand-written result controls', async () => {
  const t = tenants[0]!; const page = { offset: 0, limit: 20 };
  expect((await measure('patients-list', () => patients.list(t,page))).total).toBe(1502);
  expect(await measure('patient-label', () => patients.findByLabel(t,'syn-1'))).toBeDefined();
  expect((await measure('patient-detail', () => patients.findById(t,selected.patientId)))?.id).toBe(selected.patientId);
  expect((await measure('reports-list', () => reports.list(t,page,{}))).total).toBe(3002);
  expect((await measure('reports-by-patient', () => reports.list(t,page,{ patientId:selected.patientId }))).total).toBe(2);
  expect(await measure('report-parent-count', () => reports.countByPatient(t,selected.patientId))).toBe(2);
  expect((await measure('report-detail', () => reports.findById(t,selected.reportId)))?.id).toBe(selected.reportId);
  expect((await measure('recommendations-list', () => recommendations.list(t,page,{}))).total).toBe(3000);
  expect((await measure('recommendations-by-patient', () => recommendations.list(t,page,{ patientId:selected.patientId }))).total).toBe(2);
  expect((await measure('recommendations-by-report', () => recommendations.list(t,page,{ reportId:selected.reportId }))).total).toBe(1);
  expect((await measure('recommendation-detail', () => recommendations.findById(t,selected.recommendationId)))?.id).toBe(selected.recommendationId);
});

it('measures filtered/public pages, complete internal reads and sparse/dense context histories', async () => {
  const t=tenants[0]!; const page={ offset:0,limit:20 };
  expect((await measure('evaluations-page', () => ledger.listEvaluations(t,{},page))).total).toBe(65);
  const dense=histories[0]!; const sparse=histories[1]!;
  expect((await measure('evaluations-by-report', () => ledger.listEvaluations(t,{ reportId:dense.reportId },page))).total).toBe(60);
  expect((await measure('evaluations-by-patient', () => ledger.listEvaluations(t,{ patientId:dense.patientId },page))).total).toBe(60);
  expect((await measure('evaluations-current', () => ledger.listEvaluations(t,{ current:true },page))).total).toBe(2);
  expect((await measure('disputes-page', () => ledger.pageDisputes(t,page))).total).toBe(25);
  expect((await measure('disputes-open', () => ledger.pageDisputes(t,page,'open'))).total).toBe(12);
  expect(await measure('disputes-complete-safety-read', () => ledger.listDisputes(t))).toHaveLength(25);
  for (const [name,h] of [['dense',dense],['sparse',sparse]] as const) {
    expect((await measure(`${name}-latest-acceptance`, () => ledger.latestAcceptance(t,h.captureId)))?.decision).toBe('rejected');
    expect(await measure(`${name}-complete-corrections`, () => ledger.listCorrections(t,h.evaluationIds[0]!))).toHaveLength(2);
    expect((await measure(`${name}-context-batch`, () => ledger.evaluationContexts(t,h.evaluationIds.slice(0,20)))).size).toBe(Math.min(h.evaluationIds.length,20));
  }
});
