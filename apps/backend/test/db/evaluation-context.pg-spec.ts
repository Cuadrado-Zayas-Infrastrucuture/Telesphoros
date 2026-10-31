import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Principal } from '../../src/auth/principal';
import { Database } from '../../src/db/database';
import { EvaluationsService } from '../../src/lab-reports/evaluations.service';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { LedgerRecordsRepository } from '../../src/storage/ledger-records.repository';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let app: NestExpressApplication;
let repo: PostgresLedgerRecordsRepository;
let service: EvaluationsService;
let admin: Database;
let bypassing: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  app = await createTestApp({ labReportPipeline: true, postgresUrl: pg.appUrl });
  repo = app.get(LedgerRecordsRepository);
  service = app.get(EvaluationsService);
  admin = new Database({ url: pg.adminUrl, ssl: 'disable' });
  bypassing = new PostgresLedgerRecordsRepository(admin);
}, 60_000);
afterAll(async () => {
  await admin?.onModuleDestroy();
  await app?.close();
  await pg?.drop();
});

async function evaluations(tenant: string, count: number) {
  const report = await seedLabReport(pg.adminUrl, tenant);
  const input = captureFor(report);
  const capture = await repo.insertCapture(tenant, report.uploader, input);
  const acceptance = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(capture.record.id, input));
  const ids: string[] = [];
  for (let i = 0; i < count; i++)
    ids.push((await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, capture.record.id, acceptance.record.id, { knowledgeSetId: sha(String(i)) }))).record.id);
  return { ...report, input, captureId: capture.record.id, acceptanceId: acceptance.record.id, ids };
}

it('executes a constant number of real SQL statements for one, twenty and the maximum hundred-record page', async () => {
  const tenantId = `syn-${randomUUID()}`;
  const seeded = await evaluations(tenantId, 100);
  // Both pages have correction projections to load; the growth assertion concerns record count, not an empty-loader shortcut.
  for (const id of seeded.ids) await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: id, kind: 'retraction', reasonCode: 'software-defect' });
  const principal: Principal = { tenantId, sub: 'syn-reviewer', roles: ['clinician'] };
  async function measure(pageSize: number) {
    const query = jest.spyOn(Client.prototype, 'query'); // pass through to the REAL application-role PostgreSQL client
    try {
      const page = await service.list(principal, { page: 1, pageSize });
      return { page, queries: query.mock.calls.length };
    } finally {
      query.mockRestore();
    }
  }
  const one = await measure(1);
  const twenty = await measure(20);
  const hundred = await measure(100);
  process.stdout.write(`SQL statement count: pageSize=1 ${one.queries}; pageSize=20 ${twenty.queries}; pageSize=100 ${hundred.queries}\n`);
  expect(one.page.data).toHaveLength(1);
  expect(twenty.page.data).toHaveLength(20);
  expect(hundred.page.data).toHaveLength(100);
  expect(hundred.page.data.every((e) => e.state === 'retracted' && !e.current)).toBe(true);
  expect(one.queries).toBeGreaterThan(0);
  expect(twenty.queries).toBe(one.queries);
  expect(hundred.queries).toBe(one.queries);
  expect(hundred.queries).toBeLessThanOrEqual(14); // one transaction: BEGIN, its settings, the page and four reads, COMMIT (it was 25 in five)
});

it('preserves capture-specific latest decisions, ordered correction chains, null acceptances, and list/detail DTO parity', async () => {
  const tenantId = `syn-${randomUUID()}`;
  const a = await evaluations(tenantId, 3);
  const b = await evaluations(tenantId, 2);
  const c = await evaluations(tenantId, 0);
  const held = (
    await repo.insertEvaluation(
      tenantId,
      'syn-system',
      evaluationFor(c, c.captureId, c.acceptanceId, {
        captureAcceptanceId: null,
        disposition: 'held',
        holdCode: 'source-limit',
        geneInputs: [],
        occurrences: [],
        results: [],
        geneStates: [],
      }),
    )
  ).record.id;
  const retracted = await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: a.ids[0]!, kind: 'retraction', reasonCode: 'software-defect' });
  const reinstated = await repo.insertCorrection(tenantId, 'syn-independent', {
    evaluationId: a.ids[0]!,
    kind: 'reinstatement',
    reasonCode: 'retraction-mistaken',
    previousCorrectionId: retracted.record.id,
  });
  const superseded = await repo.insertCorrection(tenantId, 'syn-reviewer', {
    evaluationId: a.ids[0]!,
    kind: 'supersession',
    reasonCode: 'software-defect',
    previousCorrectionId: reinstated.record.id,
    replacementEvaluationId: a.ids[1]!,
  });
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: a.ids[2]!, kind: 'retraction', reasonCode: 'software-defect' });
  await repo.insertAcceptance(tenantId, 'syn-independent', acceptanceFor(a.captureId, a.input, { decision: 'rejected' }));
  // An active advisory remains tenant-wide, including when unrelated to the chosen page; clinical enforcement is unchanged.
  await repo.raiseDispute(tenantId, 'syn-reviewer', {
    guidelineId: 'syn-advisory',
    guidelineVersion: '1',
    guidelineContentSha256: sha('advisory'),
    locator: { table: '1', row: '1' },
    note: 'Synthetic evidence',
  });
  const contexts = await repo.evaluationContexts(tenantId, [held, b.ids[1]!, a.ids[0]!]);
  expect(contexts.get(held)).toEqual({ acceptance: null, corrections: [] });
  expect(contexts.get(a.ids[0]!)?.acceptance).toEqual({ id: a.acceptanceId, decision: 'accepted', current: false });
  expect(contexts.get(b.ids[1]!)?.acceptance).toEqual({ id: b.acceptanceId, decision: 'accepted', current: true });
  expect(contexts.get(a.ids[0]!)?.corrections.map((r) => r.id)).toEqual([retracted.record.id, reinstated.record.id, superseded.record.id]);
  expect(contexts.get(a.ids[0]!)?.corrections).toEqual(await repo.listCorrections(tenantId, a.ids[0]!));
  const principal: Principal = { tenantId, sub: 'syn-reviewer', roles: ['clinician'] };
  const listed = await service.list(principal, { page: 1, pageSize: 20 });
  expect(listed.data.map((e) => [e.id, e.state, e.current, e.supersededBy])).toEqual([
    [a.ids[0], 'superseded', false, a.ids[1]],
    [a.ids[1], 'active', false, null],
    [a.ids[2], 'retracted', false, null],
    [b.ids[0], 'active', false, null],
    [b.ids[1], 'active', true, null],
    [held, 'active', true, null],
  ]);
  for (const summary of listed.data) {
    const detail: Record<string, unknown> = { ...(await service.get(principal, summary.id)) };
    delete detail.geneInputs;
    expect(summary).toEqual(detail);
    expect(summary.advisory.activeDisputes).toBe(1);
  }
});

it('bounds context by requested tenant IDs, including duplicates and missing/foreign IDs when RLS is bypassed', async () => {
  const tenantId = `syn-${randomUUID()}`,
    foreignTenant = `syn-${randomUUID()}`;
  const own = await evaluations(tenantId, 2);
  const foreign = await evaluations(foreignTenant, 1);
  await repo.insertCorrection(foreignTenant, 'syn-reviewer', { evaluationId: foreign.ids[0]!, kind: 'retraction', reasonCode: 'software-defect' });
  const missing = randomUUID();
  for (const reader of [repo, bypassing]) {
    const selected = await reader.evaluationContexts(tenantId, [foreign.ids[0]!, own.ids[0]!, missing, own.ids[0]!]);
    expect([...selected.keys()]).toEqual([own.ids[0]]);
    expect(selected.get(own.ids[0]!)).toEqual({ acceptance: { id: own.acceptanceId, decision: 'accepted', current: true }, corrections: [] });
    expect(await reader.evaluationContexts(tenantId, [missing, foreign.ids[0]!])).toEqual(new Map());
  }
  const query = jest.spyOn(Client.prototype, 'query');
  try {
    expect(await repo.evaluationContexts(tenantId, [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

it('counts an open or upheld dispute as active and a dismissed one as not, for this organization only', async () => {
  const tenantId = `syn-${randomUUID()}`;
  const elsewhere = `syn-${randomUUID()}`;
  const seeded = await evaluations(tenantId, 1);
  await evaluations(elsewhere, 1);
  const raise = (tenant: string, row: string) =>
    repo.raiseDispute(tenant, 'syn-reviewer', {
      guidelineId: 'syn-advisory',
      guidelineVersion: '1',
      guidelineContentSha256: sha('advisory'),
      locator: { table: '1', row },
      note: 'Synthetic evidence',
    });
  await raise(tenantId, 'open');
  const upheld = await raise(tenantId, 'upheld');
  const dismissed = await raise(tenantId, 'dismissed');
  await repo.decideDispute(tenantId, 'syn-decider', { disputeId: upheld.record.id, decision: 'upheld', evidenceNote: 'the cell is wrong' });
  await repo.decideDispute(tenantId, 'syn-decider', { disputeId: dismissed.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
  await raise(elsewhere, 'open-1');
  await raise(elsewhere, 'open-2');
  await raise(elsewhere, 'open-3');
  const principal: Principal = { tenantId, sub: 'syn-reviewer', roles: ['clinician'] };
  expect((await service.get(principal, seeded.ids[0]!)).advisory.activeDisputes).toBe(2);
  const listed = await service.list(principal, { page: 1, pageSize: 20 });
  expect(listed.data.map((e) => e.advisory.activeDisputes)).toEqual([2]);
});

/** How many transactions `work` opens, counted on the REAL application-role PostgreSQL client. */
async function transactionsOf(work: () => Promise<unknown>): Promise<number> {
  const query = jest.spyOn(Client.prototype, 'query');
  try {
    await work().catch(() => undefined); // the caller asserts the outcome
    return (query.mock.calls as unknown[][]).filter((call) => call[0] === 'BEGIN').length;
  } finally {
    query.mockRestore();
  }
}

it('reads one evaluation, and everything shown beside it, in a single transaction', async () => {
  const tenantId = `syn-${randomUUID()}`;
  const seeded = await evaluations(tenantId, 2);
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: seeded.ids[0]!, kind: 'retraction', reasonCode: 'software-defect' });
  const principal: Principal = { tenantId, sub: 'syn-reviewer', roles: ['clinician'] };
  expect(await transactionsOf(() => service.get(principal, seeded.ids[0]!))).toBe(1);
  expect(await transactionsOf(() => service.get(principal, seeded.ids[1]!))).toBe(1);
  const unknown = randomUUID();
  expect(await transactionsOf(() => service.get(principal, unknown))).toBe(1);
  await expect(service.get(principal, unknown)).rejects.toThrow('Evaluation not found.');
});

it('reads a page of evaluations, and everything shown beside them, in a single transaction', async () => {
  const tenantId = `syn-${randomUUID()}`;
  const a = await evaluations(tenantId, 2);
  const b = await evaluations(tenantId, 1);
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: a.ids[0]!, kind: 'retraction', reasonCode: 'software-defect' });
  await repo.raiseDispute(tenantId, 'syn-reviewer', {
    guidelineId: 'syn-advisory',
    guidelineVersion: '1',
    guidelineContentSha256: sha('advisory'),
    locator: { table: '1', row: '1' },
    note: 'Synthetic evidence',
  });
  const principal: Principal = { tenantId, sub: 'syn-reviewer', roles: ['clinician'] };
  expect(await transactionsOf(() => service.list(principal, { page: 1, pageSize: 20 }))).toBe(1);
  expect(await transactionsOf(() => service.list(principal, { page: 1, pageSize: 20, current: 'true' }))).toBe(1);
  expect(await transactionsOf(() => service.list(principal, { page: 9, pageSize: 20 }))).toBe(1); // past the end
  expect(await transactionsOf(() => service.list({ ...principal, tenantId: `syn-${randomUUID()}` }, { page: 1, pageSize: 20 }))).toBe(1); // nothing at all
  // The answers, which a single transaction must not change.
  const all = await service.list(principal, { page: 1, pageSize: 20 });
  expect(all.data.map((e) => [e.id, e.current, e.advisory.activeDisputes])).toEqual([
    [a.ids[0], false, 1],
    [a.ids[1], true, 1],
    [b.ids[0], true, 1],
  ]);
  expect(all.meta.total).toBe(3);
  const currentOnly = await service.list(principal, { page: 1, pageSize: 20, current: 'true' });
  expect(currentOnly.data.map((e) => e.id)).toEqual([a.ids[1], b.ids[0]]);
  expect(currentOnly.meta.total).toBe(2);
  const past = await service.list(principal, { page: 9, pageSize: 20 });
  expect(past.data).toEqual([]);
  expect(past.meta.total).toBe(3);
  const nothing = await service.list({ ...principal, tenantId: `syn-${randomUUID()}` }, { page: 1, pageSize: 20 });
  expect(nothing.data).toEqual([]);
  expect(nothing.meta.total).toBe(0);
});

it('refuses a list when a selected evaluation is missing its context rather than fabricating an active result', async () => {
  const tenantId = `syn-${randomUUID()}`;
  await evaluations(tenantId, 1);
  const original = repo.evaluationPage.bind(repo);
  const page = jest.spyOn(repo, 'evaluationPage').mockImplementation(async (...args) => ({ ...(await original(...args)), contexts: new Map() }));
  try {
    await expect(service.list({ tenantId, sub: 'syn-reviewer', roles: ['clinician'] }, { page: 1, pageSize: 20 })).rejects.toThrow();
  } finally {
    page.mockRestore();
  }
});
