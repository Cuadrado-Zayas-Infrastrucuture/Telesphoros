import { randomUUID } from 'node:crypto';
import { CDR_BASIS } from '@telesphoros/shared-types';
import { Database } from '../../src/db/database';
import { appendEvent, newId } from '../../src/ledger/ledger-writer';
import { LedgerVerifier } from '../../src/ledger/verifier';
import {
  ResultAcknowledgementBasisChangedError,
  ResultAcknowledgementDuplicateError,
  type ResultAcknowledgementInput,
  ResultAcknowledgementNotClinicianError,
} from '../../src/storage/result-acknowledgements';
import { assertAcknowledgementBasis, insertAcknowledgementRow } from '../../src/storage/postgres/result-acknowledgements';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session, untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import type { PgError } from '../helpers/ledger-sql';

// Spec 019 D02a at the database: what holds even for a writer that bypasses the API (direct SQL as the application role), and the commit-time basis
// comparison (A4) under real lock interleaving. Expected values are written by hand; the oracle is the database's own refusal or the stored rows.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
(usingPostgres ? describe : describe.skip)('result acknowledgements in the database', () => {
  let db: EphemeralDatabase;
  let database: Database;
  let repo: PostgresLedgerRecordsRepository;
  const OPEN_GATE = { assertOpen: (): void => undefined };
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
    repo = new PostgresLedgerRecordsRepository(database);
  }, 60_000);
  afterAll(async () => {
    await database.onModuleDestroy();
    await db.drop();
  });

  /** A tenant with one verified report and one evaluation: results[0] is shown (it cites syn-guideline/recommendations/poor). */
  async function evaluated() {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    // A person is active in one organization at a time, so each tenant gets its own people.
    const clinician = `syn-clin-${tenant}`;
    const reader = `syn-read-${tenant}`;
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
    await withAdmin(db.adminUrl, async (c) => {
      for (const [sub, roles] of [
        [clinician, ['clinician']],
        [reader, ['reader']],
      ] as const) {
        await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'syn-test')`, [tenant, sub, roles]);
      }
    });
    const results = await withAdmin(
      db.adminUrl,
      async (c) =>
        (await c.query<{ id: string; outcome: string }>('SELECT id::text AS id, outcome FROM evaluation_results WHERE evaluation_id = $1 ORDER BY ordinal', [evaluation.id])).rows,
    );
    expect(results[0]!.outcome).toBe('shown'); // control: the fixture is what the tests below assume
    return { tenant, clinician, reader, evaluationId: evaluation.id as string, patientId: report.patientId, shown: results[0]!.id };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;
  const input = (s: Setup, extra: Partial<ResultAcknowledgementInput> = {}): ResultAcknowledgementInput => ({
    resultId: s.shown,
    patientId: s.patientId,
    kind: 'review',
    reviewTask: 'result-review',
    displayedBasis: ['active'],
    request: { id: randomUUID(), hash: 'a'.repeat(64) },
    ...extra,
  });
  const count = (resultId: string) =>
    withAdmin(db.adminUrl, async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM result_acknowledgements WHERE result_id = $1', [resultId])).rows[0]!.n);

  const INSERT = `INSERT INTO result_acknowledgements (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, kind,
                                                       review_task, basis, basis_rule, ledger_event_id, creation_request_id, creation_request_hash)
                  VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, $7, $8, $9::text[], 'cdr-basis-v1', $10, $11, $12)`;
  const values = (s: Setup, actor: string, row: { patient_id?: string; kind?: string; review_task?: string; basis?: string[] } = {}) => [
    newId(),
    s.tenant,
    s.shown,
    s.evaluationId,
    row.patient_id ?? s.patientId,
    actor,
    row.kind ?? 'review',
    row.review_task ?? 'result-review',
    row.basis ?? ['active'],
    newId(),
    randomUUID(),
    'b'.repeat(64),
  ];

  /** A direct INSERT as the application role, bypassing the service and the repository. Returns the database's error, if any. */
  async function directInsert(s: Setup, actor: string, row: Parameters<typeof values>[2] = {}, sessionActor = actor): Promise<PgError | undefined> {
    const session = await Session.open(db.appUrl, `ack-direct-${randomUUID().slice(0, 6)}`, s.tenant, sessionActor);
    try {
      return await session.start(INSERT, values(s, actor, row));
    } finally {
      await session.close();
    }
  }

  it('the repository stores a review (control), and a non-clinician is refused by the trigger', async () => {
    const s = await evaluated();
    expect((await repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s))).created).toBe(true);
    await expect(repo.insertResultAcknowledgement(s.tenant, s.reader, input(s))).rejects.toBeInstanceOf(ResultAcknowledgementNotClinicianError);
    expect(await count(s.shown)).toBe(1);
  });

  describe('a direct INSERT as the application role', () => {
    it('a correctly bound row by a clinician is accepted up to its missing ledger event (control)', async () => {
      const s = await evaluated();
      expect(await directInsert(s, s.clinician)).toBeUndefined(); // the deferred event check would refuse it at COMMIT; the session rolls back
    });

    it('a row naming the wrong patient is refused by the composite foreign key', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, { patient_id: randomUUID() }))?.code).toBe('23503');
    });

    it('a row by a non-clinician (a reader, or nobody) is refused by the trigger from the live membership row', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.reader))?.code).toBe('RA001');
      expect((await directInsert(s, 'syn-nobody'))?.code).toBe('RA001');
    });

    it('a row whose author is not the person bound to the transaction is refused', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, {}, s.reader))?.code).toBe('42501'); // the session's person is the reader; the row claims the clinician
    });

    it('A3 at the database: a review on a retracted basis, and "retraction reviewed" on one without, are refused by the CHECK', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, { basis: ['retracted'] }))?.constraint).toBe('result_acknowledgements_kind_basis');
      expect((await directInsert(s, s.clinician, { kind: 'retraction-reviewed' }))?.constraint).toBe('result_acknowledgements_kind_basis');
      expect(await directInsert(s, s.clinician, { kind: 'retraction-reviewed', basis: ['retracted', 'not-current'] })).toBeUndefined(); // control
    });

    it.each([[['active', 'retracted']], [['not-current', 'retracted']], [['disputed', 'disputed']], [['unknown']], [[]]])(
      'a stored basis of %j is refused by the CHECK',
      async (basis) => {
        const s = await evaluated();
        expect((await directInsert(s, s.clinician, { basis }))?.constraint).toBe('result_acknowledgements_basis');
      },
    );

    it('an unknown review task is refused by the CHECK', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, { review_task: 'decision-review' }))?.constraint).toBe('result_acknowledgements_review_task');
    });

    it('A5: a second row for the same clinician, result, task and kind is refused by the key, even in one transaction', async () => {
      const s = await evaluated();
      const session = await Session.open(db.appUrl, 'ack-once', s.tenant, s.clinician);
      try {
        expect(await session.start(INSERT, values(s, s.clinician))).toBeUndefined(); // control
        const second = await session.start(INSERT, values(s, s.clinician));
        expect(second?.code).toBe('23505');
        expect(second?.constraint).toBe('result_acknowledgements_once_uq');
      } finally {
        await session.close();
      }
    });

    it('a stored acknowledgement cannot be updated or deleted', async () => {
      const s = await evaluated();
      const { record } = await repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s));
      const session = await Session.open(db.appUrl, 'ack-mutate', s.tenant, s.clinician);
      try {
        expect(await session.start(`UPDATE result_acknowledgements SET kind = 'retraction-reviewed' WHERE id = $1`, [record.id])).toBeDefined();
      } finally {
        await session.close();
      }
      const again = await Session.open(db.appUrl, 'ack-delete', s.tenant, s.clinician);
      try {
        expect(await again.start(`DELETE FROM result_acknowledgements WHERE id = $1`, [record.id])).toBeDefined();
      } finally {
        await again.close();
      }
      expect(await count(s.shown)).toBe(1);
    });
  });

  it('A5 through the repository: a second request for the same key is the duplicate refusal, and nothing more is stored', async () => {
    const s = await evaluated();
    await repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s));
    await expect(repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s))).rejects.toBeInstanceOf(ResultAcknowledgementDuplicateError);
    expect(await count(s.shown)).toBe(1);
  });

  it('the database lists exactly the shared basis categories, in order', async () => {
    const [row] = await withAdmin(
      db.adminUrl,
      async (c) => (await c.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'result_acknowledgement_basis_valid'")).rows,
    );
    const found = /ARRAY\[([^\]]*)\]::text\[\] AS categories/.exec(row!.src);
    expect(found).not.toBeNull(); // the parser found the array, so an empty match cannot pass
    expect([...found![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...CDR_BASIS]);
  });

  describe('the basis at commit, under the ledger lock (A4)', () => {
    it('a dispute committed first makes the next review refuse after the lock, and nothing is stored', async () => {
      const s = await evaluated();
      const b = await Session.open(db.appUrl, 'ack-b', s.tenant, 'syn-reviewer');
      try {
        await b.raiseDispute(s.tenant);
        await b.commit();
      } finally {
        await b.close();
      }
      await expect(repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s))).rejects.toBeInstanceOf(ResultAcknowledgementBasisChangedError);
      expect(await count(s.shown)).toBe(0);
      // Displayed as it now is, the review is stored (control).
      expect((await repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s, { displayedBasis: ['disputed'] }))).created).toBe(true);
    });

    it('a review holding the ledger lock commits; a dispute queued behind it commits after; the review then reads as made in the earlier basis', async () => {
      const s = await evaluated();
      const a = await Session.open(db.appUrl, 'ack-a2', s.tenant, s.clinician);
      const b = await Session.open(db.appUrl, 'ack-b2', s.tenant, 'syn-reviewer');
      const ack = input(s);
      try {
        const row = await insertAcknowledgementRow(a.client as never, s.tenant, s.clinician, ack);
        if (!('inserted' in row)) throw new Error('expected a new row');
        const { rows } = await a.client.query<{ e: string }>('SELECT ledger_event_id::text AS e FROM result_acknowledgements WHERE id = $1', [row.inserted]);
        await appendEvent(OPEN_GATE, s.tenant, a.client, 'result_acknowledgements', row.inserted, rows[0]!.e); // a now holds the tenant's head lock
        const prepared = await b.prepareDispute(s.tenant); // the dispute names the shown result's cited cell
        const queued = b.appendPrepared(prepared);
        await untilBlocked(db.adminUrl, 'ack-b2');
        await assertAcknowledgementBasis(a.client as never, s.tenant, ack); // the dispute is not committed: the basis is still the one displayed
        await a.commit();
        await queued;
        await b.commit();
      } finally {
        await a.close();
        await b.close();
      }
      const found = await repo.resultAcknowledgements(s.tenant, s.shown);
      expect(found?.basis.basis).toEqual(['disputed']);
      expect(found?.entries.map((e) => e.basis)).toEqual([['active']]); // the review stands with the basis it was made in; nothing rewrote it
    });
  });

  it('the tenant ledger verifies with acknowledgements in it', async () => {
    const s = await evaluated();
    await repo.insertResultAcknowledgement(s.tenant, s.clinician, input(s));
    const verifier = LedgerVerifier.connect(db.verifierUrl);
    try {
      expect(await verifier.verify(s.tenant)).toMatchObject({ status: 'ok', failures: [] });
    } finally {
      await verifier.close();
    }
  });
});
