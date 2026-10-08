import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerVerifier, type FailureKind } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  verifier = LedgerVerifier.connect(pg.verifierUrl);
});
afterAll(async () => {
  await verifier.close();
  await database.onModuleDestroy();
  await pg.drop();
});

/** A tenant with a capture, an accepted capture, an evaluation (with children), a correction, and a dispute with a note. */
async function chain(): Promise<{ tenantId: string; report: SeededReport; ids: Record<string, string> }> {
  const tenantId = `tenant-${randomUUID()}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'checked against the page' }));
  const e = await repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  const k = await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: e.record.id, kind: 'retraction', reasonCode: 'input-misread', note: 'misread' });
  const d = await repo.raiseDispute(tenantId, 'syn-reviewer', {
    guidelineId: 'syn-guideline', guidelineVersion: '1', guidelineContentSha256: 'a'.repeat(64), locator: { table: 'recommendations', row: 'poor' }, note: 'cell looks wrong',
  });
  return { tenantId, report, ids: { capture: c.record.id, acceptance: a.record.id, evaluation: e.record.id, correction: k.record.id, dispute: d.record.id } };
}

/** The attacker model: a superuser who switches off triggers and foreign keys, edits, and switches them back on. */
async function tamper(work: (c: Client) => Promise<unknown>) {
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query(`SET session_replication_role = replica`);
    await work(c);
  });
}
const kinds = (r: { failures: { kind: FailureKind }[] }) => [...new Set(r.failures.map((f) => f.kind))].sort();

describe('ledger verifier: an intact chain', () => {
  it('verifies in full and in tail mode, and records a checkpoint that tail mode starts from', async () => {
    const { tenantId } = await chain();
    const full = await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    expect(full).toMatchObject({ status: 'ok', mode: 'full', eventsChecked: 5, headSeq: '5', failures: [] });
    expect(full.checkpointId).toEqual(expect.any(String));
    const tail = await verifier.verify(tenantId, { mode: 'tail' });
    expect(tail).toMatchObject({ status: 'ok', mode: 'tail', eventsChecked: 1 }); // only the checkpoint's own event is newer
    const again = await verifier.verify(tenantId, { mode: 'full' });
    expect(again).toMatchObject({ status: 'ok', eventsChecked: 6, headSeq: '6' });
  });

  it('walks a chain longer than nine events in numeric order, and starts a tail check from the NEWEST checkpoint', async () => {
    // Regression: sequence numbers were once sorted as text ("10" before "2"), which only shows from the tenth event on.
    const tenantId = `tenant-${randomUUID()}`;
    for (let i = 0; i < 9; i++) await repo.insertCapture(tenantId, 'syn-uploader', captureFor(await seedLabReport(pg.adminUrl, tenantId)));
    await verifier.verify(tenantId, { recordCheckpoint: true }); // up to 9 (its own event is 10)
    for (let i = 0; i < 3; i++) await repo.insertCapture(tenantId, 'syn-uploader', captureFor(await seedLabReport(pg.adminUrl, tenantId)));
    await verifier.verify(tenantId, { recordCheckpoint: true }); // up to 13 (its own event is 14)
    expect(await verifier.verify(tenantId, { mode: 'full' })).toMatchObject({ status: 'ok', eventsChecked: 14, failures: [] });
    expect(await verifier.verify(tenantId, { mode: 'tail' })).toMatchObject({ status: 'ok', mode: 'tail', eventsChecked: 1 });
  });

  it('falls back to a full walk when a tail is requested but no checkpoint exists', async () => {
    const { tenantId } = await chain();
    expect(await verifier.verify(tenantId, { mode: 'tail' })).toMatchObject({ status: 'ok', mode: 'full', eventsChecked: 5 });
  });

  it('is incomplete, never ok, when the budget runs out, and writes no checkpoint', async () => {
    const { tenantId } = await chain();
    const byEvents = await verifier.verify(tenantId, { maxEvents: 2, recordCheckpoint: true });
    expect(byEvents).toMatchObject({ status: 'incomplete', eventsChecked: 2, checkpointId: null });
    const byTime = await verifier.verify(tenantId, { budgetMs: -1, recordCheckpoint: true });
    expect(byTime).toMatchObject({ status: 'incomplete', eventsChecked: 0, checkpointId: null });
    // The budget is exactly the chain length: complete, not incomplete.
    expect(await verifier.verify(tenantId, { maxEvents: 5 })).toMatchObject({ status: 'ok' });
    const count = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ledger_checkpoints WHERE tenant_id = $1`, [tenantId])).rows[0].n);
    expect(count).toBe(0);
  });

  it('reports an empty ledger as ok at genesis', async () => {
    expect(await verifier.verify(`tenant-${randomUUID()}`)).toMatchObject({ status: 'ok', headSeq: '0', eventsChecked: 0 });
  });

  it('lists the tenants that have a ledger', async () => {
    const { tenantId } = await chain();
    expect(await verifier.tenants()).toContain(tenantId);
  });
});

describe('ledger verifier: tampering by someone who can bypass every trigger', () => {
  const cases: Array<[string, FailureKind, (c: Client, t: { tenantId: string; ids: Record<string, string> }) => Promise<unknown>]> = [
    ['an edited record field', 'payload-mismatch', (c, t) => c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1`, [t.ids.capture])],
    ['an edited evaluation result', 'payload-mismatch', (c, t) => c.query(`UPDATE evaluation_results SET drug = 'other' WHERE evaluation_id = $1 AND ordinal = 0`, [t.ids.evaluation])],
    ['an edited gene state', 'payload-mismatch', (c, t) => c.query(`UPDATE evaluation_gene_states SET phenotype = 'Normal Metabolizer' WHERE evaluation_id = $1 AND gene = 'CYP2C19'`, [t.ids.evaluation])],
    ['an extra result row added to an evaluation', 'payload-mismatch', (c, t) => c.query(
      `INSERT INTO evaluation_results (tenant_id, evaluation_id, ordinal, drug, genes, outcome, reason_code, gene_evidence)
       VALUES ($1, $2, 9, 'x', '{}', 'no-guideline', 'no-guideline-for-drug', '[]')`, [t.tenantId, t.ids.evaluation])],
    ['an edited event payload', 'record-hash-mismatch', (c, t) => c.query(`UPDATE ledger_events SET payload_sha256 = repeat('b', 64) WHERE tenant_id = $1 AND seq = 2`, [t.tenantId])],
    ['an edited event actor', 'record-hash-mismatch', (c, t) => c.query(`UPDATE ledger_events SET actor_sub = 'someone-else' WHERE tenant_id = $1 AND seq = 2`, [t.tenantId])],
    ['a deleted middle event', 'seq-gap', (c, t) => c.query(`DELETE FROM ledger_events WHERE tenant_id = $1 AND seq = 3`, [t.tenantId])],
    ['a deleted last event', 'head-mismatch', (c, t) => c.query(`DELETE FROM ledger_events WHERE tenant_id = $1 AND seq = 5`, [t.tenantId])],
    ['a forged prev_hash', 'prev-hash-mismatch', (c, t) => c.query(`UPDATE ledger_events SET prev_hash = repeat('c', 64) WHERE tenant_id = $1 AND seq = 4`, [t.tenantId])],
    ['a moved head', 'head-mismatch', (c, t) => c.query(`UPDATE ledger_heads SET record_hash = repeat('d', 64) WHERE tenant_id = $1`, [t.tenantId])],
    ['a deleted record whose event remains', 'record-missing', (c, t) => c.query(`DELETE FROM report_captures WHERE id = $1`, [t.ids.capture])],
    ['a record inserted without an event', 'row-without-event', (c, t) => c.query(
      `INSERT INTO cell_disputes (tenant_id, created_by, ledger_event_id, guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, note_id)
       SELECT tenant_id, 'x', gen_random_uuid(), 'g', '1', repeat('e', 64), 't', 'r', note_id FROM cell_disputes WHERE id = $1`, [t.ids.dispute])],
    ['an event pointing at a different record', 'record-event-mismatch', (c, t) => c.query(`UPDATE report_captures SET ledger_event_id = $2 WHERE id = $1`, [t.ids.capture,
      '00000000-0000-0000-0000-000000000000'])],
    ['an edited note body', 'note-digest-mismatch', (c, t) => c.query(`UPDATE event_notes SET body = 'rewritten' WHERE tenant_id = $1 AND body = 'cell looks wrong'`, [t.tenantId])],
    ['a note tombstoned without a redaction event', 'note-redaction-invalid', (c, t) => c.query(
      `UPDATE event_notes SET body = '[redacted]', redacted_at = now(), redaction_basis_code = 'other-approved' WHERE tenant_id = $1 AND body = 'misread'`, [t.tenantId])],
  ];

  it.each(cases)('detects %s as %s', async (_name, kind, attack) => {
    const t = await chain();
    expect((await verifier.verify(t.tenantId)).status).toBe('ok'); // the same chain is clean before the attack
    await tamper((c) => attack(c, t));
    const result = await verifier.verify(t.tenantId);
    expect(result.status).toBe('failed');
    expect(kinds(result)).toContain(kind);
    expect(JSON.stringify(result)).not.toMatch(/someone-else|rewritten|cell looks wrong|misread/); // failures name kinds and sequence numbers, never values
  });

  it('does not report the tenant next door (control: tampering one tenant leaves another ok)', async () => {
    const [a, b] = [await chain(), await chain()];
    await tamper((c) => c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1`, [a.ids.capture]).then(() => undefined));
    expect((await verifier.verify(a.tenantId)).status).toBe('failed');
    expect((await verifier.verify(b.tenantId)).status).toBe('ok');
  });

  it('does not cry wolf (control: rewriting a value with itself is not tampering)', async () => {
    const t = await chain();
    await tamper((c) => c.query(`UPDATE report_captures SET text_scalars = text_scalars WHERE id = $1`, [t.ids.capture]).then(() => undefined));
    expect((await verifier.verify(t.tenantId)).status).toBe('ok');
  });

  it('a tail check that starts at a checkpoint still sees tampering AFTER it, and a rewritten checkpoint target', async () => {
    const t = await chain();
    await verifier.verify(t.tenantId, { recordCheckpoint: true });
    const e = await repo.insertEvaluation(t.tenantId, 'syn-system', evaluationFor(t.report, t.ids.capture, t.ids.acceptance, { engineVersion: 'syn-2' }));
    expect((await verifier.verify(t.tenantId, { mode: 'tail' })).status).toBe('ok');
    await tamper((c) => c.query(`UPDATE evaluations SET engine_version = 'forged' WHERE id = $1`, [e.record.id]).then(() => undefined));
    expect(kinds(await verifier.verify(t.tenantId, { mode: 'tail' }))).toContain('payload-mismatch');
    await tamper((c) => c.query(`UPDATE ledger_events SET record_hash = repeat('f', 64) WHERE tenant_id = $1 AND seq = 5`, [t.tenantId]).then(() => undefined));
    expect(kinds(await verifier.verify(t.tenantId, { mode: 'tail' }))).toContain('checkpoint-mismatch');
  });
});
