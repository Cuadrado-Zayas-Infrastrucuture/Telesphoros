import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let database: Database;
let admin: Database;
let repo: PostgresLedgerRecordsRepository;
let bypassing: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  admin = new Database({ url: pg.adminUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  bypassing = new PostgresLedgerRecordsRepository(admin);
});
afterAll(async () => { await database.onModuleDestroy(); await admin.onModuleDestroy(); await pg.drop(); });

async function evaluations(tenant: string, count: number) {
  const report = await seedLabReport(pg.adminUrl, tenant);
  const input = captureFor(report);
  const capture = await repo.insertCapture(tenant, report.uploader, input);
  const acceptance = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(capture.record.id, input));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, capture.record.id, acceptance.record.id, { knowledgeSetId: sha(String(i)) }))).record.id);
  return { ...report, ids };
}

it('pages by sequence, counts filtered matches on empty pages, and never promotes an old evaluation after retraction', async () => {
  const tenant = `syn-${randomUUID()}`;
  const a = await evaluations(tenant, 23);
  const b = await evaluations(tenant, 2);
  const first = await repo.listEvaluations(tenant, {}, { offset: 0, limit: 20 });
  expect(first.items.map((e) => e.id)).toEqual(a.ids.slice(0, 20));
  expect(first.total).toBe(25);
  const last = await repo.listEvaluations(tenant, {}, { offset: 20, limit: 20 });
  expect(last.items.map((e) => e.id)).toEqual([...a.ids.slice(20), ...b.ids]);
  expect(last.total).toBe(25);
  expect(await repo.listEvaluations(tenant, { reportId: a.reportId }, { offset: 100, limit: 20 })).toEqual({ items: [], total: 23 });
  expect((await repo.listEvaluations(tenant, { patientId: b.patientId }, { offset: 1, limit: 1 })).items.map((e) => e.id)).toEqual([b.ids[1]]);
  expect((await repo.listEvaluations(tenant, { patientId: b.patientId }, { offset: 1, limit: 1 })).total).toBe(2);
  await repo.insertCorrection(tenant, 'syn-reviewer', { evaluationId: a.ids.at(-1)!, kind: 'retraction', reasonCode: 'software-defect' });
  const current = await repo.listEvaluations(tenant, { current: true }, { offset: 0, limit: 1 });
  expect(current.items.map((e) => e.id)).toEqual([b.ids[1]]);
  expect(current.total).toBe(1);
  expect(await repo.listEvaluations(tenant, { current: true, reportId: a.reportId }, { offset: 0, limit: 20 })).toEqual({ items: [], total: 0 });
});

it('filters dispute status in SQL before bounds, includes decisions, and retains the complete internal read', async () => {
  const tenant = `syn-${randomUUID()}`;
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) ids.push((await repo.raiseDispute(tenant, 'syn-reviewer', {
    guidelineId: 'syn-guideline', guidelineVersion: '1', guidelineContentSha256: sha('syn'), locator: { table: '1', row: String(i) }, note: 'Synthetic evidence',
  })).record.id);
  for (const [id, decision] of [[ids[0]!, 'dismissed'], [ids[1]!, 'upheld'], [ids[22]!, 'upheld']] as const) {
    await repo.decideDispute(tenant, 'syn-independent', { disputeId: id, decision, evidenceNote: 'Synthetic decision' });
  }
  const first = await repo.pageDisputes(tenant, { offset: 0, limit: 20 });
  expect(first.items.map((d) => d.dispute.id)).toEqual(ids.slice(0, 20));
  expect(first.total).toBe(23);
  const upheld = await repo.pageDisputes(tenant, { offset: 1, limit: 1 }, 'upheld');
  expect(upheld.total).toBe(2);
  expect(upheld.items).toHaveLength(1);
  expect(upheld.items[0]).toMatchObject({ dispute: { id: ids[22] }, status: 'upheld', decision: { decision: 'upheld' } });
  expect(await repo.pageDisputes(tenant, { offset: 20, limit: 20 }, 'open')).toEqual({ items: [], total: 20 });
  expect((await repo.pageDisputes(tenant, { offset: 0, limit: 20 }, 'open')).items.map((d) => d.dispute.id)).toEqual(ids.slice(2, 22));
  expect(await repo.listDisputes(tenant)).toHaveLength(23);
});

it('protects rows AND counts with explicit tenant predicates even when RLS is bypassed', async () => {
  const a = `syn-${randomUUID()}`, b = `syn-${randomUUID()}`;
  const ea = await evaluations(a, 2);
  await evaluations(b, 3);
  const input = { guidelineId: 'syn', guidelineVersion: '1', guidelineContentSha256: sha('syn'), locator: { table: '1', row: '1' }, note: 'Synthetic evidence' };
  const da = await repo.raiseDispute(a, 'syn-reviewer', input);
  await repo.raiseDispute(b, 'syn-reviewer', input);
  for (const reader of [repo, bypassing]) {
    const page = await reader.listEvaluations(a, {}, { offset: 0, limit: 1 });
    expect(page.items.map((e) => e.id)).toEqual(ea.ids.slice(0, 1));
    expect(page.total).toBe(2);
    expect(await reader.listEvaluations('syn-empty', {}, { offset: 0, limit: 20 })).toEqual({ items: [], total: 0 });
    const disputes = await reader.pageDisputes(a, { offset: 0, limit: 20 }, 'open');
    expect(disputes.items.map((d) => d.dispute.id)).toEqual([da.record.id]);
    expect(disputes.total).toBe(1);
    expect(await reader.pageDisputes('syn-empty', { offset: 0, limit: 20 })).toEqual({ items: [], total: 0 });
  }
});
