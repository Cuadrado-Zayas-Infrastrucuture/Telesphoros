import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { DataOriginError } from '../../src/ledger/data-origin';
import { newId } from '../../src/ledger/ledger-writer';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';
import type { PgError } from '../helpers/ledger-sql';

// Spec 020 E1a at the database: what holds for the repository and, separately, for a writer that bypasses it (direct SQL as the application role). The
// expected values are written by hand; the oracle is the database's own refusal (its error code and constraint name) or the stored rows.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
const ACTOR = 'syn-prov-actor';

(usingPostgres ? describe : describe.skip)('data provenance in the database', () => {
  let db: EphemeralDatabase;
  let database: Database;
  let repo: PostgresLedgerRecordsRepository;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
    repo = new PostgresLedgerRecordsRepository(database);
  }, 60_000);
  afterAll(async () => {
    await database.onModuleDestroy();
    await db.drop();
  });

  const rows = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(db.adminUrl, async (c) => (await c.query(sql, values)).rows as T[]);

  /** One tenant with a captured, accepted and evaluated report, each written by the repository (so each has its provenance). */
  async function facts() {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const report = await seedLabReport(db.adminUrl, tenant);
    const capture = captureFor(report);
    const stored = await repo.insertCapture(tenant, report.uploader, capture);
    const acceptance = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
    await repo.insertPatientDecision(tenant, 'syn-verifier', {
      reportId: report.reportId,
      expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'no-identifier-on-report',
    });
    const evaluation = (await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id))).record;
    return { tenant, report, captureId: stored.record.id as string, acceptanceId: acceptance.record.id as string, evaluationId: evaluation.id as string };
  }
  type Facts = Awaited<ReturnType<typeof facts>>;

  describe('the repository', () => {
    it('stores one provenance row per fact, in the fact transaction, with the values the tasks table names', async () => {
      const f = await facts();
      const capture = (await rows(`SELECT * FROM data_provenance WHERE capture_id = $1`, [f.captureId]))[0]!;
      const reportRow = (await rows<{ uploaded_at: Date }>(`SELECT uploaded_at FROM reports WHERE id = $1`, [f.report.reportId]))[0]!;
      expect(capture).toMatchObject({
        tenant_id: f.tenant,
        created_by: f.report.uploader,
        subject_kind: 'capture',
        evaluation_id: null,
        origin: 'synthetic',
        interpretation: null,
        document_sha256: f.report.pdfSha256,
        object_version: f.report.objectVersion,
        transform_runner: 'fake',
        transform_poppler_version: '26.03.0',
        transform_engine_version: null,
        transform_knowledge_set_id: null,
        parent_kind: 'report',
        parent_id: f.report.reportId,
        source_organization: null,
        source_type: null,
        context: null,
        collection_location: null,
      });
      expect(new Date(capture.received_at as Date).getTime()).toBe(reportRow.uploaded_at.getTime());

      const evaluation = (await rows(`SELECT * FROM data_provenance WHERE evaluation_id = $1`, [f.evaluationId]))[0]!;
      expect(evaluation).toMatchObject({
        tenant_id: f.tenant,
        created_by: 'syn-system',
        subject_kind: 'evaluation',
        capture_id: null,
        origin: 'synthetic',
        interpretation: 'software-derived',
        document_sha256: f.report.pdfSha256,
        object_version: null,
        received_at: null,
        transform_runner: null,
        transform_poppler_version: null,
        transform_engine_version: 'syn-1',
        transform_knowledge_set_id: sha('knowledge'),
        parent_kind: 'capture-acceptance',
        parent_id: f.acceptanceId,
        source_organization: null,
        source_type: null,
        context: null,
        collection_location: null,
      });
      // One ledger event each, of its own type, about its own row.
      expect(await rows(`SELECT subject_table, count(*)::int AS n FROM ledger_events WHERE tenant_id = $1 AND event_type = 'data-provenance' GROUP BY 1`, [f.tenant])).toEqual([
        { subject_table: 'data_provenance', n: 2 },
      ]);
    });

    it('an evaluation that relied on no acceptance names the capture as its parent', async () => {
      const f = await facts();
      const report = await seedLabReport(db.adminUrl, f.tenant);
      const capture = captureFor(report);
      const stored = await repo.insertCapture(f.tenant, report.uploader, capture);
      const held = await repo.insertEvaluation(f.tenant, 'syn-system', {
        ...evaluationFor(report, stored.record.id, f.acceptanceId, {
          captureAcceptanceId: null,
          disposition: 'held',
          holdCode: 'source-limit',
          results: [],
          geneStates: [],
          geneInputs: [],
          occurrences: [],
        }),
      });
      expect(await rows(`SELECT parent_kind, parent_id::text FROM data_provenance WHERE evaluation_id = $1`, [held.record.id])).toEqual([
        { parent_kind: 'capture', parent_id: stored.record.id },
      ]);
    });

    it('does not write a second row for a fact that already exists', async () => {
      const f = await facts();
      const again = await repo.insertCapture(f.tenant, f.report.uploader, { ...captureFor(f.report), textStorageKey: `text/${randomUUID()}` });
      expect(again.created).toBe(false);
      expect(await rows(`SELECT count(*)::int AS n FROM data_provenance WHERE tenant_id = $1`, [f.tenant])).toEqual([{ n: 2 }]);
    });

    it('a capture or an evaluation with no origin is refused in code and nothing at all is stored', async () => {
      const f = await facts();
      const report = await seedLabReport(db.adminUrl, f.tenant);
      const capture = { ...captureFor(report), origin: undefined as never };
      await expect(repo.insertCapture(f.tenant, report.uploader, capture)).rejects.toBeInstanceOf(DataOriginError);
      await expect(repo.insertCapture(f.tenant, report.uploader, { ...capture, origin: 'invented' as never })).rejects.toBeInstanceOf(DataOriginError);
      expect(await rows(`SELECT count(*)::int AS n FROM report_captures WHERE report_id = $1`, [report.reportId])).toEqual([{ n: 0 }]);

      const good = await repo.insertCapture(f.tenant, report.uploader, captureFor(report));
      const acceptance = await repo.insertAcceptance(f.tenant, 'syn-reviewer', acceptanceFor(good.record.id, captureFor(report)));
      const before = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = $1`, [f.tenant]);
      await expect(
        repo.insertEvaluation(f.tenant, 'syn-system', { ...evaluationFor(report, good.record.id, acceptance.record.id), origin: undefined as never }),
      ).rejects.toBeInstanceOf(DataOriginError);
      expect(await rows(`SELECT count(*)::int AS n FROM evaluations WHERE report_id = $1`, [report.reportId])).toEqual([{ n: 0 }]);
      expect(await rows(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = $1`, [f.tenant])).toEqual(before);
    });

    it('the database allows `real`, so the first real path needs a decision in code and not a migration (and no path writes it today)', async () => {
      const f = await facts();
      const report = await seedLabReport(db.adminUrl, f.tenant);
      const stored = await repo.insertCapture(f.tenant, report.uploader, { ...captureFor(report), origin: 'real' });
      expect(await rows(`SELECT origin FROM data_provenance WHERE capture_id = $1`, [stored.record.id])).toEqual([{ origin: 'real' }]);
    });
  });

  describe('the table', () => {
    it('has exactly these columns, and none that carries a permission, purpose, consent or eligibility (P4)', async () => {
      const columns = (
        await rows<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'data_provenance' ORDER BY ordinal_position`,
        )
      ).map((r) => r.column_name);
      expect(columns).toEqual([
        'seq',
        'id',
        'tenant_id',
        'created_by',
        'created_at',
        'ledger_event_id',
        'subject_kind',
        'capture_id',
        'evaluation_id',
        'origin',
        'interpretation',
        'document_sha256',
        'object_version',
        'received_at',
        'transform_runner',
        'transform_poppler_version',
        'transform_engine_version',
        'transform_knowledge_set_id',
        'parent_kind',
        'parent_id',
        'source_organization',
        'source_type',
        'context',
        'collection_location',
      ]);
      expect(columns.filter((c) => /purpose|consent|eligib|permission|grant|withdraw/.test(c))).toEqual([]);
    });

    it('`origin` is required and has no default', async () => {
      expect(await rows(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'data_provenance' AND column_name = 'origin'`)).toEqual([
        { is_nullable: 'NO', column_default: null },
      ]);
    });

    it('is row-level secured and FORCEd, and append-only for everyone', async () => {
      expect(await rows(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'data_provenance'::regclass`)).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const f = await facts();
      await withAdmin(db.adminUrl, async (c) => {
        // The owner and a superuser are refused by the trigger; the application role has no UPDATE, DELETE or TRUNCATE privilege at all.
        await expect(c.query(`UPDATE data_provenance SET origin = 'real' WHERE tenant_id = $1`, [f.tenant])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`DELETE FROM data_provenance WHERE tenant_id = $1`, [f.tenant])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`TRUNCATE data_provenance CASCADE`)).rejects.toMatchObject({ code: '23000' });
      });
      const app = new Client({ connectionString: db.appUrl });
      await app.connect();
      try {
        for (const sql of [`UPDATE data_provenance SET origin = 'real'`, `DELETE FROM data_provenance`, `TRUNCATE data_provenance`]) {
          await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await app.end();
      }
      expect(await rows(`SELECT count(*)::int AS n FROM data_provenance WHERE tenant_id = $1 AND origin = 'synthetic'`, [f.tenant])).toEqual([{ n: 2 }]); // nothing above changed a row
    });

    it('isolates organizations: another organization sees none of these rows and cannot write into them', async () => {
      const a = await facts();
      const b = await facts();
      const visible = async (tenant: string) => {
        const s = await Session.open(db.appUrl, `prov-rls-${randomUUID().slice(0, 6)}`, tenant, ACTOR);
        try {
          return (await s.client.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM data_provenance')).rows.map((r) => r.tenant_id);
        } finally {
          await s.close();
        }
      };
      expect(await visible(a.tenant)).toEqual([a.tenant]); // positive control: the organization's own rows are there
      expect(await visible(b.tenant)).toEqual([b.tenant]);
      expect(await visible(`t-${randomUUID().slice(0, 8)}`)).toEqual([]);
      // A row for A written inside B's transaction is refused by the trigger that binds the row to the transaction's organization.
      const s = await Session.open(db.appUrl, 'prov-cross', b.tenant, ACTOR);
      try {
        const error = await s.start(...insertSql({ ...captureRow(a), tenant_id: a.tenant }));
        expect(error?.code).toBe('42501');
      } finally {
        await s.close();
      }
    });
  });

  // ---- direct INSERT as the application role: what holds for a writer that bypasses the repository -------------------------------------------------------

  type Row = Record<string, unknown>;
  const HASH = 'a'.repeat(64);
  /** A well-formed capture provenance row for `f`'s capture (which already has one, so a correct row is refused only by the unique key). */
  const captureRow = (f: Facts): Row => ({
    id: newId(),
    tenant_id: f.tenant,
    created_by: ACTOR,
    ledger_event_id: newId(),
    subject_kind: 'capture',
    capture_id: f.captureId,
    origin: 'synthetic',
    document_sha256: HASH,
    transform_runner: 'fake',
    transform_poppler_version: '26.03.0',
    parent_kind: 'report',
    parent_id: f.report.reportId,
  });
  const evaluationRow = (f: Facts): Row => ({
    id: newId(),
    tenant_id: f.tenant,
    created_by: ACTOR,
    ledger_event_id: newId(),
    subject_kind: 'evaluation',
    evaluation_id: f.evaluationId,
    origin: 'synthetic',
    interpretation: 'software-derived',
    document_sha256: HASH,
    transform_engine_version: 'syn-1',
    transform_knowledge_set_id: 'syn-knowledge',
    parent_kind: 'capture-acceptance',
    parent_id: f.acceptanceId,
  });
  /** `undefined` leaves the column out of the statement; `null` names it as NULL. */
  function insertSql(row: Row): [string, unknown[]] {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    return [`INSERT INTO data_provenance (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k])];
  }
  async function direct(f: Facts, row: Row, sessionActor = ACTOR): Promise<PgError | undefined> {
    const s = await Session.open(db.appUrl, `prov-direct-${randomUUID().slice(0, 6)}`, f.tenant, sessionActor);
    try {
      return await s.start(...insertSql(row));
    } finally {
      await s.close();
    }
  }

  describe('a direct INSERT as the application role', () => {
    it('a well-formed row for a fact that already has its provenance is refused by the unique key, and by nothing else (control)', async () => {
      const f = await facts();
      expect(await direct(f, captureRow(f))).toMatchObject({ code: '23505', constraint: 'data_provenance_capture_uq' });
      expect(await direct(f, evaluationRow(f))).toMatchObject({ code: '23505', constraint: 'data_provenance_evaluation_uq' });
    });

    it('a row with no origin is refused by NOT NULL, whether the column is left out or named as NULL', async () => {
      const f = await facts();
      expect(await direct(f, { ...captureRow(f), origin: undefined })).toMatchObject({ code: '23502', column: 'origin' });
      expect(await direct(f, { ...captureRow(f), origin: null })).toMatchObject({ code: '23502', column: 'origin' });
      expect(await direct(f, { ...evaluationRow(f), origin: undefined })).toMatchObject({ code: '23502', column: 'origin' });
    });

    it.each([
      ['an origin outside the two', { origin: 'maybe' }, 'data_provenance_origin'],
      ['an interpretation outside the two', { interpretation: 'guessed' }, 'data_provenance_interpretation'],
      ['a context outside the three', { context: 'marketing' }, 'data_provenance_context'],
      ['a document hash that is not a sha-256', { document_sha256: 'xyz' }, 'data_provenance_document_hash'],
      ['a capture row that also names an evaluation', { evaluation_id: randomUUID() }, 'data_provenance_subject_ref'],
      ['a capture row carrying an engine version', { transform_engine_version: 'syn-1' }, 'data_provenance_transformation'],
      ['a capture row without its runner', { transform_runner: null }, 'data_provenance_transformation'],
      ['a capture whose parent is not a report', { parent_kind: 'capture', parent_id: '__capture__' }, 'data_provenance_parent_kind'],
      ['an empty source organization', { source_organization: '' }, 'data_provenance_text_len'],
    ])('%s is refused by its CHECK', async (_label, over, constraint) => {
      const f = await facts();
      const filled = Object.fromEntries(Object.entries(over).map(([k, v]) => [k, v === '__capture__' ? f.captureId : v]));
      expect(await direct(f, { ...captureRow(f), ...filled })).toMatchObject({ code: '23514', constraint });
    });

    it('an evaluation row without its knowledge set, or with a runner, is refused', async () => {
      const f = await facts();
      expect(await direct(f, { ...evaluationRow(f), transform_knowledge_set_id: null })).toMatchObject({ code: '23514', constraint: 'data_provenance_transformation' });
      expect(await direct(f, { ...evaluationRow(f), transform_runner: 'fake' })).toMatchObject({ code: '23514', constraint: 'data_provenance_transformation' });
      expect(await direct(f, { ...evaluationRow(f), parent_kind: 'report', parent_id: f.report.reportId })).toMatchObject({
        code: '23514',
        constraint: 'data_provenance_parent_kind',
      });
      expect(await direct(f, { ...evaluationRow(f), subject_kind: 'report' })).toMatchObject({ code: '23514' }); // (the parent-kind CHECK reads the subject kind too, and is named first)
    });

    it('a row about a fact that does not exist in this organization is refused by the composite foreign key', async () => {
      const f = await facts();
      const other = await facts();
      expect(await direct(f, { ...captureRow(f), capture_id: randomUUID() })).toMatchObject({ code: '23503', constraint: 'data_provenance_capture_fk' });
      expect(await direct(f, { ...captureRow(f), capture_id: other.captureId })).toMatchObject({ code: '23503', constraint: 'data_provenance_capture_fk' }); // another organization's capture
      expect(await direct(f, { ...evaluationRow(f), evaluation_id: other.evaluationId })).toMatchObject({ code: '23503', constraint: 'data_provenance_evaluation_fk' });
    });

    it('a row whose parent asset is missing, or belongs to another organization, is refused by the trigger', async () => {
      const f = await facts();
      const other = await facts();
      expect(await direct(f, { ...captureRow(f), parent_id: randomUUID() })).toMatchObject({ code: '23000' });
      expect(await direct(f, { ...captureRow(f), parent_id: other.report.reportId })).toMatchObject({ code: '23000' });
    });

    it('a row by someone other than the person bound to the transaction is refused by the trigger', async () => {
      const f = await facts();
      expect(await direct(f, captureRow(f), 'syn-someone-else')).toMatchObject({ code: '42501' });
    });
  });

  // ---- T105: the ledger over facts written before and after the migration ----------------------------------------------------------------------------------

  describe('the ledger verifies across the migration (T105)', () => {
    let own: EphemeralDatabase;
    let ownDatabase: Database;
    let ownRepo: PostgresLedgerRecordsRepository;
    beforeAll(async () => {
      own = await createEphemeralDatabase();
      ownDatabase = new Database({ url: own.appUrl, ssl: 'disable' });
      ownRepo = new PostgresLedgerRecordsRepository(ownDatabase);
    }, 60_000);
    afterAll(async () => {
      await ownDatabase.onModuleDestroy();
      await own.drop();
    });

    const verify = async (tenant: string) => {
      const verifier = LedgerVerifier.connect(own.verifierUrl);
      try {
        return await verifier.verify(tenant);
      } finally {
        await verifier.close();
      }
    };

    it('a tenant whose chain holds facts without provenance (before 0062) and facts with it (after) verifies, and the check goes red when a provenance row is altered', async () => {
      const tenant = `t-${randomUUID().slice(0, 8)}`;

      // BEFORE: the database as it was at 0061. 0062 is empty, so it reverts; facts are then written the way the previous release wrote them.
      expect(await withAdmin(own.adminUrl, (c) => migrateDown(c, 1))).toEqual(['0062']);
      const oldReport = await seedLabReport(own.adminUrl, tenant);
      const old = await Session.open(own.appUrl, 'prov-before', tenant, oldReport.uploader);
      const oldCaptureId = await old.insertCapture(oldReport); // the pre-0062 INSERT and event, no provenance
      await old.client.query('COMMIT');
      await old.close();
      const oldAcceptance = await ownRepo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(oldCaptureId, captureFor(oldReport)));
      expect(oldAcceptance.created).toBe(true);

      // THE MIGRATION, with events already in the chain: it restates the ledger's type set and subject mapping over them. (The verifier of this code reads
      // every record table, so it is first run against the migrated schema; the two old events are what it walks.)
      expect(await withAdmin(own.adminUrl, (c) => migrateUp(c))).toEqual(['0062']);
      expect(await verify(tenant)).toMatchObject({ status: 'ok', failures: [], eventsChecked: 2 });

      // AFTER: a capture and an evaluation through the repository, each with its provenance event in the same chain.
      const report = await seedLabReport(own.adminUrl, tenant);
      const capture = captureFor(report);
      const stored = await ownRepo.insertCapture(tenant, report.uploader, capture);
      const acceptance = await ownRepo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
      await ownRepo.insertPatientDecision(tenant, 'syn-verifier', {
        reportId: report.reportId,
        expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
        decision: 'verified',
        method: 'person-confirmed',
        basisCode: 'no-identifier-on-report',
      });
      await ownRepo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id));

      const types = await withAdmin(own.adminUrl, async (c) =>
        (await c.query<{ event_type: string }>(`SELECT event_type FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`, [tenant])).rows.map((r) => r.event_type),
      );
      expect(types).toEqual([
        'capture', // before
        'capture-decision', // before
        'capture', // after, then its provenance
        'data-provenance',
        'capture-decision',
        'patient-link-decision',
        'evaluation',
        'data-provenance',
      ]);
      expect(await verify(tenant)).toMatchObject({ status: 'ok', failures: [], eventsChecked: 8 });
      // The old capture has no provenance (its origin was never recorded and is not guessed); the new ones do.
      expect(
        await withAdmin(
          own.adminUrl,
          async (c) =>
            (
              await c.query(
                `SELECT c.id::text AS capture, p.id IS NOT NULL AS has FROM report_captures c LEFT JOIN data_provenance p ON p.capture_id = c.id WHERE c.tenant_id = $1 ORDER BY c.seq`,
                [tenant],
              )
            ).rows,
        ),
      ).toEqual([
        { capture: oldCaptureId, has: false },
        { capture: stored.record.id, has: true },
      ]);

      // A check that cannot go red is not a check: alter a provenance row behind the triggers' back and the walk must name it.
      const altered = await withAdmin(own.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        const r = await c.query<{ id: string }>(`UPDATE data_provenance SET origin = 'real' WHERE capture_id = $1 RETURNING id::text AS id`, [stored.record.id]);
        await c.query('COMMIT');
        return r.rows[0]!.id;
      });
      const red = await verify(tenant);
      expect(red.status).not.toBe('ok');
      expect(red.failures).toEqual([{ kind: 'payload-mismatch', seq: '4' }]); // seq 4 is that capture's provenance event (1 and 2 are the old facts, 3 the new capture)
      expect(altered).toEqual(expect.any(String));
      await withAdmin(own.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE data_provenance SET origin = 'synthetic' WHERE id = $1`, [altered]);
        await c.query('COMMIT');
      });
      expect(await verify(tenant)).toMatchObject({ status: 'ok', failures: [] });
    }, 120_000);
  });
});
