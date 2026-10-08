import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport, sha } from '../helpers/ledger-fixtures';
import { attempt, run, uuid } from '../helpers/ledger-sql';

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

const newTenant = () => `tenant-${randomUUID()}`;
async function stored(tenantId = newTenant()) {
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'a note' }));
  const e = await repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  // One of every record table, so a table that never gets a row cannot pass the "there is something to attack" controls.
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: e.record.id, kind: 'retraction', reasonCode: 'input-misread', note: 'retracted' });
  const d = await repo.raiseDispute(tenantId, 'syn-reviewer', {
    guidelineId: 'syn-guideline', guidelineVersion: '1', guidelineContentSha256: 'a'.repeat(64), locator: { table: 'recommendations', row: 'poor' }, note: 'disputed',
  });
  await repo.decideDispute(tenantId, 'syn-reviewer-2', { disputeId: d.record.id, decision: 'upheld', evidenceNote: 'evidence' });
  await verifier.verify(tenantId, { recordCheckpoint: true });
  return { tenantId, report, capture, c, a, e };
}
const CAPTURE_INSERT = `INSERT INTO report_captures (id, tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5, '26.03.0', 'fake')`;
const captureValues = (r: SeededReport, id: string, eventId: string, createdBy: string) => [id, r.tenantId, createdBy, eventId, r.reportId, r.pdfSha256, `text/${uuid()}`, sha(`t${id}`)];

const RECORD_TABLES = ['report_captures', 'capture_acceptances', 'evaluations', 'evaluation_results', 'evaluation_gene_states', 'corrections', 'cell_disputes', 'cell_dispute_decisions'];
const APPEND_ONLY = [...RECORD_TABLES, 'ledger_events', 'ledger_checkpoints'];

describe('append-only: nobody updates, deletes or truncates, the owner included', () => {
  it.each(APPEND_ONLY)('%s refuses UPDATE, DELETE and TRUNCATE from the owner (a superuser)', async (table) => {
    const { tenantId } = await stored();
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
      const rowsBefore = Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
      expect(rowsBefore).toBeGreaterThan(0); // control: there is something to attack
      await expect(c.query(`UPDATE ${table} SET tenant_id = tenant_id`)).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: '23000' });
    });
  });

  it.each(APPEND_ONLY)('%s: the application role has no UPDATE, DELETE or TRUNCATE privilege', async (table) => {
    const { tenantId } = await stored();
    for (const sql of [`UPDATE ${table} SET tenant_id = tenant_id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      expect((await attempt(pg.appUrl, tenantId, 'syn-x', (c) => c.query(sql)))?.code).toBe('42501');
    }
  });

  it('the application role cannot write the ledger at all, nor read another tenant\'s', async () => {
    const { tenantId } = await stored();
    const other = newTenant();
    expect((await attempt(pg.appUrl, tenantId, 'syn-x', (c) => c.query(`INSERT INTO ledger_events SELECT * FROM ledger_events LIMIT 1`)))?.code).toBe('42501');
    expect((await attempt(pg.appUrl, tenantId, 'syn-x', (c) => c.query(`INSERT INTO ledger_heads VALUES ('x', 0, repeat('0', 64))`)))?.code).toBe('42501');
    expect((await attempt(pg.appUrl, tenantId, 'syn-x', (c) => c.query(`UPDATE ledger_heads SET seq = 99`)))?.code).toBe('42501');
    const own = await run(pg.appUrl, tenantId, 'syn-x', (c) => c.query(`SELECT count(*)::int AS n FROM ledger_events`));
    const foreign = await run(pg.appUrl, other, 'syn-x', (c) => c.query(`SELECT count(*)::int AS n FROM ledger_events`));
    expect([own.rows[0].n, foreign.rows[0].n]).toEqual([7, 0]);
  });
});

describe('ledger functions: who may call what', () => {
  const args = (type: string, table: string, subject = uuid()) => [uuid(), type, table, subject, 'a'.repeat(64)];
  it('the application cannot append a redaction or checkpoint event, or call the internal function', async () => {
    const t = newTenant();
    for (const type of ['redaction', 'checkpoint']) {
      expect((await attempt(pg.appUrl, t, 'syn-x', (c) => c.query(`SELECT ledger_append($1, $2, $3, $4, $5, 1::smallint)`, args(type, 'event_notes'))))?.code).toBe('42501');
    }
    expect((await attempt(pg.appUrl, t, 'syn-x', (c) => c.query(`SELECT ledger_append_internal($1, $2, $3, $4, $5, 1::smallint)`, args('capture', 'report_captures'))))?.code).toBe('42501');
    expect((await attempt(pg.appUrl, t, 'syn-x', (c) => c.query(`SELECT ledger_record_checkpoint($1, 1, $2, 'full')`, [t, 'a'.repeat(64)])))?.code).toBe('42501');
  });

  it('refuses an event type that does not match its table, and an append without tenant or actor', async () => {
    const t = newTenant();
    expect((await attempt(pg.appUrl, t, 'syn-x', (c) => c.query(`SELECT ledger_append($1, $2, $3, $4, $5, 1::smallint)`, args('capture', 'evaluations'))))?.code).toBe('23514');
    expect((await attempt(pg.appUrl, t, null, (c) => c.query(`SELECT ledger_append($1, $2, $3, $4, $5, 1::smallint)`, args('capture', 'report_captures'))))?.code).toBe('42501');
    expect((await attempt(pg.appUrl, null, 'syn-x', (c) => c.query(`SELECT ledger_append($1, $2, $3, $4, $5, 1::smallint)`, args('capture', 'report_captures'))))?.code).toBe('42501');
  });

  it('the verifier login can read everything and write nothing but a checkpoint', async () => {
    const { tenantId, c } = await stored();
    expect((await run(pg.verifierUrl, null, null, (x) => x.query(`SELECT count(*)::int AS n FROM report_captures`))).rows[0].n).toBeGreaterThan(0);
    for (const sql of [`DELETE FROM ledger_events`, `INSERT INTO ledger_heads VALUES ('x', 0, repeat('0', 64))`, `UPDATE report_captures SET text_scalars = 1`, `INSERT INTO event_notes (tenant_id, created_by, body, body_sha256) VALUES ('t', 'a', 'b', repeat('a', 64))`]) {
      expect((await attempt(pg.verifierUrl, null, null, (x) => x.query(sql)))?.code).toBe('42501');
    }
    expect((await attempt(pg.verifierUrl, tenantId, 'v', (x) => x.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [uuid(), c.record.id, 'a'.repeat(64)])))?.code).toBe('42501');
    // A checkpoint that does not match the chain is refused by the function itself.
    expect((await attempt(pg.verifierUrl, null, null, (x) => x.query(`SELECT ledger_record_checkpoint($1, 1, $2, 'full')`, [tenantId, 'e'.repeat(64)])))?.code).toBe('23000');
  });

  it('the verifier is not a member of the application role, and the application role is not a member of the ledger roles', async () => {
    await withAdmin(pg.adminUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT pg_has_role('telesphoros_test_verifier', 'telesphoros_app', 'MEMBER') AS verifier_in_app,
                pg_has_role('telesphoros_app', 'telesphoros_ledger', 'MEMBER') AS app_in_ledger,
                pg_has_role('telesphoros_app', 'telesphoros_redactor', 'MEMBER') AS app_in_redactor,
                pg_has_role('telesphoros_test_app', 'telesphoros_ledger_verifier', 'MEMBER') AS applogin_in_verifier,
                pg_has_role('telesphoros_test_operator', 'telesphoros_app', 'MEMBER') AS operator_in_app`);
      expect(rows[0]).toEqual({ verifier_in_app: false, app_in_ledger: false, app_in_redactor: false, applogin_in_verifier: false, operator_in_app: false });
    });
  });
});

describe('the commit-time contract: a record and its event exist together or not at all', () => {
  it('a record with no event cannot commit', async () => {
    const t = newTenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const error = await attempt(pg.appUrl, t, r.uploader, (c) => c.query(CAPTURE_INSERT, captureValues(r, uuid(), uuid(), r.uploader)));
    expect(error?.code).toBe('23503');
    expect(await rows(t, 'report_captures')).toBe(0);
  });

  it('an event with no record cannot commit', async () => {
    const t = newTenant();
    const error = await attempt(pg.appUrl, t, 'syn-x', (c) => c.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [uuid(), uuid(), 'a'.repeat(64)]));
    expect(error?.code).toBe('23000');
    expect(await events(t)).toBe(0);
  });

  it('an event whose actor is not the record\'s author cannot commit', async () => {
    const t = newTenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const [id, ev] = [uuid(), uuid()];
    const error = await attempt(pg.appUrl, t, 'actor-b', async (c) => {
      await c.query(CAPTURE_INSERT, captureValues(r, id, ev, 'actor-a'));
      await c.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [ev, id, 'a'.repeat(64)]);
    });
    expect(error?.code).toBe('23000');
    expect(await rows(t, 'report_captures')).toBe(0);
  });

  it('a record cannot reuse the event of another record', async () => {
    const s = await stored();
    const r2 = await seedLabReport(pg.adminUrl, s.tenantId, 'syn-uploader', 'SYN-2');
    const error = await attempt(pg.appUrl, s.tenantId, r2.uploader, (c) => c.query(CAPTURE_INSERT, captureValues(r2, uuid(), s.c.record.ledgerEventId as string, r2.uploader)));
    expect(error?.code).toBe('23000'); // the event exists, but it describes another row
  });

  it('a record cannot commit with an event that belongs to another tenant', async () => {
    const s = await stored();
    const t2 = newTenant();
    const r2 = await seedLabReport(pg.adminUrl, t2);
    const error = await attempt(pg.appUrl, t2, r2.uploader, (c) => c.query(CAPTURE_INSERT, captureValues(r2, uuid(), s.c.record.ledgerEventId as string, r2.uploader)));
    expect(error?.code).toBe('23503');
  });

  it('a failure after the insert, after the append, or in the middle of the transaction leaves nothing and does not move the head', async () => {
    const t = newTenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const base = await head(t);
    for (const stage of ['after-insert', 'after-append'] as const) {
      const [id, ev] = [uuid(), uuid()];
      const error = await attempt(pg.appUrl, t, r.uploader, async (c) => {
        await c.query(CAPTURE_INSERT, captureValues(r, id, ev, r.uploader));
        if (stage === 'after-append') await c.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [ev, id, 'a'.repeat(64)]);
        throw new Error('injected failure');
      });
      expect(error?.message).toBe('injected failure');
    }
    expect(await rows(t, 'report_captures')).toBe(0);
    expect(await events(t)).toBe(0);
    expect(await head(t)).toEqual(base);
    // And the ledger is not wedged: a normal write succeeds afterwards.
    await repo.insertCapture(t, r.uploader, captureFor(r));
    expect(await events(t)).toBe(1);
  });

  it('a connection killed mid-transaction leaves nothing and releases the head lock', async () => {
    const t = newTenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const { Client } = await import('pg');
    const victim = new Client({ connectionString: pg.appUrl });
    victim.on('error', () => undefined);
    await victim.connect();
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await victim.query('BEGIN');
    await victim.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [t, r.uploader]);
    const [id, ev] = [uuid(), uuid()];
    await victim.query(CAPTURE_INSERT, captureValues(r, id, ev, r.uploader));
    await victim.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [ev, id, 'a'.repeat(64)]);
    await withAdmin(pg.adminUrl, (c) => c.query('SELECT pg_terminate_backend($1)', [pid]));
    await victim.end().catch(() => undefined); // intentional: already terminated
    expect(await rows(t, 'report_captures')).toBe(0);
    expect(await events(t)).toBe(0);
    await repo.insertCapture(t, r.uploader, captureFor(r)); // would block for the lock timeout if the lock had leaked
    expect(await events(t)).toBe(1);
  });
});

describe('evaluations are immutable once finalized', () => {
  it('no result or gene state can be added after the ledger event is visible', async () => {
    const s = await stored();
    const addResult = `INSERT INTO evaluation_results (tenant_id, evaluation_id, ordinal, drug, genes, outcome, reason_code, gene_evidence)
                       VALUES ($1, $2, 99, 'x', '{}', 'no-guideline', 'no-guideline-for-drug', '[]')`;
    expect((await attempt(pg.appUrl, s.tenantId, 'syn-x', (c) => c.query(addResult, [s.tenantId, s.e.record.id])))?.code).toBe('23000');
    expect((await attempt(pg.appUrl, s.tenantId, 'syn-x', (c) => c.query(
      `INSERT INTO evaluation_gene_states (tenant_id, evaluation_id, gene, state, reason_code) VALUES ($1, $2, 'ZZZ', 'absent', 'gene-absent')`, [s.tenantId, s.e.record.id])))?.code).toBe('23000');
  });

  it('a held evaluation is accepted only without an acceptance, and an evaluated one needs the LATEST accepted decision', async () => {
    const t = newTenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const capture = captureFor(r);
    const c = await repo.insertCapture(t, r.uploader, capture);
    const held = await repo.insertEvaluation(t, 'syn-system', evaluationFor(r, c.record.id, '', {
      captureAcceptanceId: null, disposition: 'held', holdCode: 'capture-not-accepted', geneInputs: [], occurrences: [], results: [], geneStates: [],
    }));
    expect(held.created).toBe(true);
    const a1 = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
    await repo.insertAcceptance(t, 'syn-reviewer-2', acceptanceFor(c.record.id, capture, { decision: 'rejected' }));
    await expect(repo.insertEvaluation(t, 'syn-system', evaluationFor(r, c.record.id, a1.record.id))).rejects.toMatchObject({ name: 'LedgerIntegrityError' });
  });
});

describe('tenant isolation, table by table', () => {
  it.each([...RECORD_TABLES, 'event_notes', 'ledger_events', 'ledger_heads'])('%s: another tenant, or none, sees nothing; the owner tenant sees its rows', async (table) => {
    const s = await stored();
    const other = newTenant();
    const count = (tenant: string | null) => run(pg.appUrl, tenant, 'syn-x', (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`)).then((r) => r.rows[0].n as number);
    expect(await count(s.tenantId)).toBeGreaterThan(0); // control
    expect(await count(other)).toBe(0);
    expect(await count(null)).toBe(0);
  });

  it('refuses to write a record for another tenant than the one in force', async () => {
    const a = await stored();
    const other = newTenant();
    const note = [uuid(), a.tenantId, 'syn-x', 'body', sha('body')];
    const error = await attempt(pg.appUrl, other, 'syn-x', (c) => c.query(`INSERT INTO event_notes (id, tenant_id, created_by, body, body_sha256) VALUES ($1, $2, $3, $4, $5)`, note));
    expect(error?.code).toBe('42501'); // row-level security: the new row violates the policy
    // And a record insert for the wrong tenant is refused too (by whichever rule fires first), leaving nothing behind.
    const before = await rows(a.tenantId, 'report_captures');
    expect(await attempt(pg.appUrl, other, 'syn-x', (c) => c.query(CAPTURE_INSERT, captureValues(a.report, uuid(), uuid(), 'syn-x')))).toBeDefined();
    expect(await rows(a.tenantId, 'report_captures')).toBe(before);
  });
});

describe('redaction of a note', () => {
  async function noteOf(tenantId: string): Promise<{ id: string; bodySha: string }> {
    const rows = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT id::text AS id, body_sha256 FROM event_notes WHERE tenant_id = $1 ORDER BY seq LIMIT 1`, [tenantId])).rows);
    return { id: rows[0].id, bodySha: rows[0].body_sha256 };
  }
  const redact = (tenantId: string, id: string, basis: string, url = pg.operatorUrl) =>
    attempt(url, tenantId, 'operator-1', (c) => c.query(`SELECT redact_event_note($1, $2, $3)`, [id, uuid(), basis]));

  it('an operator redacts a note atomically: tombstone, basis and a chained event; the chain still verifies', async () => {
    const s = await stored();
    const note = await noteOf(s.tenantId);
    expect(await redact(s.tenantId, note.id, 'phi-in-note')).toBeUndefined();
    const row = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT body, redacted_at IS NOT NULL AS redacted, redaction_basis_code, body_sha256 FROM event_notes WHERE id = $1`, [note.id])).rows[0]);
    expect(row).toEqual({ body: '[redacted]', redacted: true, redaction_basis_code: 'phi-in-note', body_sha256: note.bodySha });
    expect(await events(s.tenantId)).toBe(8);
    expect(await verifier.verify(s.tenantId)).toMatchObject({ status: 'ok', eventsChecked: 8 });
    // The parent record's own event still verifies: it committed to the digest, not to the text.
    expect(await repo.findEvaluation(s.tenantId, s.e.record.id)).toEqual(s.e.record);
  });

  it('refuses a second redaction, an unknown basis, and any caller who is not an operator', async () => {
    const s = await stored();
    const note = await noteOf(s.tenantId);
    expect((await redact(s.tenantId, note.id, 'because'))?.code).toBe('23514');
    expect((await redact(s.tenantId, note.id, 'phi-in-note', pg.appUrl))?.code).toBe('42501');
    expect((await redact(s.tenantId, note.id, 'phi-in-note', pg.verifierUrl))?.code).toBe('42501');
    expect(await redact(s.tenantId, note.id, 'legal-order')).toBeUndefined();
    expect((await redact(s.tenantId, note.id, 'legal-order'))?.code).toBe('23000');
    expect(await events(s.tenantId)).toBe(8);
  });

  it('cannot redact a note of a tenant other than the one in force', async () => {
    const s = await stored();
    const note = await noteOf(s.tenantId);
    expect((await redact(newTenant(), note.id, 'phi-in-note'))?.code).toBe('P0002');
  });

  it('the application cannot change a note, and an owner who tombstones one without the event is refused by the trigger', async () => {
    const s = await stored();
    const note = await noteOf(s.tenantId);
    expect((await attempt(pg.appUrl, s.tenantId, 'syn-x', (c) => c.query(`UPDATE event_notes SET body = 'x' WHERE id = $1`, [note.id])))?.code).toBe('42501');
    await withAdmin(pg.adminUrl, async (c) => {
      await expect(c.query(`UPDATE event_notes SET body = '[redacted]', redacted_at = now(), redaction_basis_code = 'phi-in-note' WHERE id = $1`, [note.id])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`UPDATE event_notes SET body = 'other text' WHERE id = $1`, [note.id])).rejects.toMatchObject({ code: '23000' });
    });
  });
});

async function rows(tenantId: string, table: string): Promise<number> {
  return withAdmin(pg.adminUrl, async (c) => Number((await c.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].count));
}
async function events(tenantId: string): Promise<number> {
  return rows(tenantId, 'ledger_events');
}
async function head(tenantId: string): Promise<unknown> {
  return withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT seq::text, record_hash FROM ledger_heads WHERE tenant_id = $1`, [tenantId])).rows[0] ?? null);
}
