import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { appendEvent, newId } from '../../src/ledger/ledger-writer';
import { ClinicianDecisionBasisError, type ClinicianDecisionInput } from '../../src/storage/clinician-decisions';
import { assertDecisionBasis, insertDecisionRow } from '../../src/storage/postgres/clinician-decisions';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session, untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import type { PgError } from '../helpers/ledger-sql';

// Spec 006 D01b at the database: what holds even for a writer that bypasses the API (direct SQL as the application role), and the commit-time
// basis rule under real lock interleaving. Expected values are written by hand; the oracle is the database's own refusal or the stored rows.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
(usingPostgres ? describe : describe.skip)('clinician result decisions in the database', () => {
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

  /** A tenant with one verified report and one evaluation: results[0] is shown (it cites syn-guideline/recommendations/poor), results[1] is held. */
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
    expect(results.map((r) => r.outcome)).toEqual(['shown', 'held', 'no-guideline']); // control: the fixture is what the tests below assume
    return { tenant, clinician, reader, report, evaluationId: evaluation.id as string, patientId: report.patientId, shown: results[0]!.id, held: results[1]!.id };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;
  const input = (s: Setup, resultId = s.shown, extra: Partial<ClinicianDecisionInput> = {}): ClinicianDecisionInput => ({
    resultId,
    evaluationId: s.evaluationId,
    patientId: s.patientId,
    entryKind: 'decision',
    previousEntryId: null,
    response: 'accepted',
    detailCodes: [],
    reviewBy: null,
    request: { id: randomUUID(), hash: 'a'.repeat(64) },
    ...extra,
  });
  const count = (resultId: string) =>
    withAdmin(db.adminUrl, async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM clinician_result_decisions WHERE result_id = $1', [resultId])).rows[0]!.n);

  /** A direct INSERT as the application role, bypassing the service and the repository. Returns the database's error, if any. */
  async function directInsert(s: Setup, actor: string, overrides: Record<string, unknown> = {}): Promise<PgError | undefined> {
    const session = await Session.open(db.appUrl, `cdr-direct-${randomUUID().slice(0, 6)}`, s.tenant, actor);
    try {
      const row = {
        result_id: s.shown,
        evaluation_id: s.evaluationId,
        patient_id: s.patientId,
        entry_kind: 'decision',
        response: 'accepted',
        detail_codes: [] as string[],
        ...overrides,
      };
      return await session.start(
        `INSERT INTO clinician_result_decisions (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, entry_kind,
                                                 response, detail_codes, vocabulary_version, occurred_at_source, eligibility_policy, ledger_event_id,
                                                 creation_request_id, creation_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, $7, $8, $9::text[], 'cdr-v1', 'recorded', 'cdr-eligibility-v1', $10, $11, $12)`,
        [newId(), s.tenant, row.result_id, row.evaluation_id, row.patient_id, actor, row.entry_kind, row.response, row.detail_codes, newId(), randomUUID(), 'b'.repeat(64)],
      );
    } finally {
      await session.close();
    }
  }

  it('the repository stores a decision on a shown result (control) and refuses one on a held result (T05d)', async () => {
    const s = await evaluated();
    expect((await repo.insertClinicianDecision(s.tenant, s.clinician, input(s))).created).toBe(true);
    await expect(repo.insertClinicianDecision(s.tenant, s.clinician, input(s, s.held))).rejects.toBeInstanceOf(ClinicianDecisionBasisError);
    expect(await count(s.held)).toBe(0);
  });

  describe('a direct INSERT as the application role (T01, roles, rules)', () => {
    it('a correctly bound row by a clinician is accepted up to its missing ledger event (control)', async () => {
      const s = await evaluated();
      expect(await directInsert(s, s.clinician)).toBeUndefined(); // the deferred event check would refuse it at COMMIT; the session rolls back
    });

    it('a row naming the wrong patient is refused by the composite foreign key', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, { patient_id: randomUUID() }))?.code).toBe('23503');
    });

    it('a row by a non-clinician (a reader) is refused by the trigger from the live membership row', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.reader))?.code).toBe('CD001');
      expect((await directInsert(s, 'syn-nobody'))?.code).toBe('CD001');
    });

    it('an accepted row with codes, or a modification without a change code, is refused by the CHECK', async () => {
      const s = await evaluated();
      expect((await directInsert(s, s.clinician, { detail_codes: ['not-applicable'] }))?.code).toBe('23514');
      expect((await directInsert(s, s.clinician, { response: 'modified', detail_codes: ['access'] }))?.code).toBe('23514');
      expect(await directInsert(s, s.clinician, { response: 'modified', detail_codes: ['change-dose'] })).toBeUndefined(); // control
    });

    it('a row whose author is not the person bound to the transaction is refused', async () => {
      const s = await evaluated();
      const session = await Session.open(db.appUrl, 'cdr-actor', s.tenant, s.reader);
      try {
        const error = await session.start(
          `INSERT INTO clinician_result_decisions (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, entry_kind,
                                                   response, detail_codes, vocabulary_version, occurred_at_source, eligibility_policy, ledger_event_id,
                                                   creation_request_id, creation_request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, 'decision', 'accepted', '{}', 'cdr-v1', 'recorded', 'cdr-eligibility-v1', $7, $8, $9)`,
          [newId(), s.tenant, s.shown, s.evaluationId, s.patientId, s.clinician, newId(), randomUUID(), 'b'.repeat(64)],
        );
        expect(error?.code).toBe('42501'); // the session's person is the reader; the row claims the clinician
      } finally {
        await session.close();
      }
    });

    it('an amendment of another clinician’s entry is refused by the trigger (CD002); the author’s own is accepted (control)', async () => {
      const s = await evaluated();
      const other = `syn-clin2-${s.tenant}`;
      await withAdmin(db.adminUrl, (c) =>
        c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['clinician'], 'syn-test')`, [s.tenant, other]),
      );
      const first = (await repo.insertClinicianDecision(s.tenant, s.clinician, input(s))).record.id as string;
      const amend = async (actor: string) => {
        const session = await Session.open(db.appUrl, `cdr-amend-${randomUUID().slice(0, 6)}`, s.tenant, actor);
        try {
          return await session.start(
            `INSERT INTO clinician_result_decisions (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, entry_kind,
                                                     previous_entry_id, response, detail_codes, vocabulary_version, occurred_at_source, eligibility_policy,
                                                     ledger_event_id, creation_request_id, creation_request_hash)
             VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, 'amendment', $7, 'accepted', '{}', 'cdr-v1', 'recorded', 'cdr-eligibility-v1', $8, $9, $10)`,
            [newId(), s.tenant, s.shown, s.evaluationId, s.patientId, actor, first, newId(), randomUUID(), 'b'.repeat(64)],
          );
        } finally {
          await session.close();
        }
      };
      expect((await amend(other))?.code).toBe('CD002');
      expect(await amend(s.clinician)).toBeUndefined();
    });

    it('the chain keys allow one first entry per result: a second one in the same transaction is refused', async () => {
      const s = await evaluated();
      const session = await Session.open(db.appUrl, 'cdr-chain', s.tenant, s.clinician);
      try {
        const first = () =>
          session.start(
            `INSERT INTO clinician_result_decisions (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, entry_kind,
                                                     response, detail_codes, vocabulary_version, occurred_at_source, eligibility_policy, ledger_event_id,
                                                     creation_request_id, creation_request_hash)
             VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, 'decision', 'accepted', '{}', 'cdr-v1', 'recorded', 'cdr-eligibility-v1', $7, $8, $9)`,
            [newId(), s.tenant, s.shown, s.evaluationId, s.patientId, s.clinician, newId(), randomUUID(), 'b'.repeat(64)],
          );
        expect(await first()).toBeUndefined(); // control
        const second = await first();
        expect(second?.code).toBe('23505');
        expect(second?.constraint).toBe('clinician_result_decisions_first_uq');
      } finally {
        await session.close();
      }
    });

    it('a stored entry cannot be updated or deleted', async () => {
      const s = await evaluated();
      const { record } = await repo.insertClinicianDecision(s.tenant, s.clinician, input(s));
      const session = await Session.open(db.appUrl, 'cdr-mutate', s.tenant, s.clinician);
      try {
        expect(await session.start(`UPDATE clinician_result_decisions SET response = 'rejected' WHERE id = $1`, [record.id])).toBeDefined();
      } finally {
        await session.close();
      }
      const again = await Session.open(db.appUrl, 'cdr-delete', s.tenant, s.clinician);
      try {
        expect(await again.start(`DELETE FROM clinician_result_decisions WHERE id = $1`, [record.id])).toBeDefined();
      } finally {
        await again.close();
      }
      expect(await count(s.shown)).toBe(1);
    });
  });

  describe('the basis at commit, under the ledger lock (D3)', () => {
    it('T05b: a decision holding the ledger lock commits; a dispute queued behind it commits after; the history then shows it disputed', async () => {
      const s = await evaluated();
      const a = await Session.open(db.appUrl, 'cdr-a', s.tenant, s.clinician);
      const b = await Session.open(db.appUrl, 'cdr-b', s.tenant, 'syn-reviewer');
      try {
        const row = await insertDecisionRow(a.client as never, s.tenant, s.clinician, input(s), async () => {
          throw new Error('no note in this test');
        });
        if (!('inserted' in row)) throw new Error('expected a new row');
        const { rows } = await a.client.query<{ e: string }>('SELECT ledger_event_id::text AS e FROM clinician_result_decisions WHERE id = $1', [row.inserted]);
        await appendEvent(OPEN_GATE, s.tenant, a.client, 'clinician_result_decisions', row.inserted, rows[0]!.e); // a now holds the tenant's head lock
        const prepared = await b.prepareDispute(s.tenant); // the dispute names the shown result's cited cell
        const queued = b.appendPrepared(prepared);
        await untilBlocked(db.adminUrl, 'cdr-b');
        await assertDecisionBasis(a.client as never, s.tenant, s.shown); // the dispute is not committed: the basis is still eligible
        await a.commit();
        await queued;
        await b.commit();
      } finally {
        await a.close();
        await b.close();
      }
      const history = await repo.clinicianDecisionHistory(s.tenant, s.shown);
      expect(history?.basis.basis).toEqual(['disputed']);
      expect(history?.entries).toHaveLength(1); // the decision stands; nothing rewrote it
    });

    it('T05a at the database: a dispute committed first makes the next decision refuse after the lock', async () => {
      const s = await evaluated();
      const b = await Session.open(db.appUrl, 'cdr-b2', s.tenant, 'syn-reviewer');
      try {
        await b.raiseDispute(s.tenant);
        await b.commit();
      } finally {
        await b.close();
      }
      await expect(repo.insertClinicianDecision(s.tenant, s.clinician, input(s))).rejects.toBeInstanceOf(ClinicianDecisionBasisError);
      expect(await count(s.shown)).toBe(0);
    });
  });
});
