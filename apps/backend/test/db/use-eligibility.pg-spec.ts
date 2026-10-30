import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session, untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, type SeededReport } from '../helpers/ledger-fixtures';
import { attempt, type PgError } from '../helpers/ledger-sql';
import {
  type Answer,
  askUse,
  DAY,
  grantRow,
  HASH,
  insertSql,
  insertUseRecord,
  PURPOSES,
  restrictionRow,
  type Row,
  termsRow,
  USE_RECORD_TABLES,
  type UseRecordTable,
  validationRow,
  when,
  withdrawalRow,
  writeUseRecord,
} from '../helpers/use-eligibility-fixtures';

// Spec 020 E1b at the database: the five records and the policy `use-eligibility-v1`. The expected values are written by hand; the oracle is the database's
// own refusal (its error code and constraint name), the stored rows, or the policy's answer. Synthetic data only.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
const RECORDER = 'syn-recorder';
const VALIDATOR = 'syn-validator';

(usingPostgres ? describe : describe.skip)('use-eligibility records and the policy use-eligibility-v1', () => {
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
  /** The database's clock, as text with microseconds. */
  const now = async () => (await rows<{ t: string }>(`SELECT clock_timestamp()::text AS t`))[0]!.t;
  const sorted = (ids: string[]) => [...ids].sort();

  interface World {
    tenant: string;
    patient: string;
    report: SeededReport;
    captureId: string;
  }
  /** A fresh organization with one patient and one synthetic capture (written by the repository, so it has its provenance row). */
  async function world(origin: 'synthetic' | 'real' = 'synthetic'): Promise<World> {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const report = await seedLabReport(db.adminUrl, tenant);
    const stored = await repo.insertCapture(tenant, report.uploader, { ...captureFor(report), origin });
    return { tenant, patient: report.patientId, report, captureId: stored.record.id as string };
  }

  /** The evaluation of the world's capture, written by the repository (so it has its provenance row). */
  async function evaluate(w: World): Promise<string> {
    const capture = captureFor(w.report);
    const acceptance = await repo.insertAcceptance(w.tenant, 'syn-reviewer', acceptanceFor(w.captureId, capture));
    await repo.insertPatientDecision(w.tenant, 'syn-verifier', {
      reportId: w.report.reportId,
      expectedReport: { patientId: w.patient, sha256: w.report.pdfSha256, objectVersion: w.report.objectVersion },
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'no-identifier-on-report',
    });
    return (await repo.insertEvaluation(w.tenant, 'syn-system', evaluationFor(w.report, w.captureId, acceptance.record.id))).record.id as string;
  }

  interface Setup {
    terms?: Row | false;
    grant?: Row | false;
    validate?: boolean;
    withdrawal?: Row | false;
    restriction?: Row | false;
  }
  interface Ids {
    terms?: string;
    grant?: string;
    validation?: string;
    withdrawal?: string;
    restriction?: string;
  }
  /** The in-force baseline unless told otherwise: terms authorizing everything, a research grant for ZZ, validated by someone else. */
  async function setup(w: World, o: Setup = {}): Promise<Ids> {
    const ids: Ids = {};
    if (o.terms !== false) ids.terms = (await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator', o.terms ?? {}))).id;
    if (o.grant !== false) {
      ids.grant = (await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, o.grant ?? {}))).id;
      if (o.validate !== false) ids.validation = (await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, ids.grant, VALIDATOR))).id;
      if (o.withdrawal !== undefined && o.withdrawal !== false)
        ids.withdrawal = (await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, ids.grant, RECORDER, o.withdrawal))).id;
    }
    if (o.restriction !== undefined && o.restriction !== false)
      ids.restriction = (await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, o.restriction))).id;
    return ids;
  }
  /** The policy's answer for the world's patient, capture and `research`, as of `at` (default: the database's clock after everything above was written). */
  async function ask(w: World, over: Partial<Parameters<typeof askUse>[2]> = {}): Promise<Answer> {
    return askUse(db.appUrl, w.tenant, { patient: w.patient, purpose: 'research', factId: w.captureId, at: await now(), ...over });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // The policy: one test per reason code, and an eligible control (T204).
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  describe('use_eligibility: fails closed, one reason code at a time', () => {
    it('ELIGIBLE (control): ZZ, a validated grant in force, terms authorizing the purpose and the classification, a synthetic fact with provenance', async () => {
      const w = await world();
      const ids = await setup(w);
      const provenance = (await rows<{ id: string }>(`SELECT id::text AS id FROM data_provenance WHERE capture_id = $1`, [w.captureId]))[0]!.id;
      const answer = await ask(w);
      expect(answer).toEqual({
        eligible: true,
        reason_codes: [],
        evidence_ids: sorted([ids.terms!, ids.grant!, ids.validation!, provenance]),
        legal_authority: 'authorization',
        data_classification: 'identifiable',
        policy_version: 'use-eligibility-v1',
      });
    });

    it('is also eligible for clinical care on real data (control for the origin test below), with the grant\u2019s legal authority', async () => {
      const w = await world('real');
      await setup(w, { grant: { purpose: 'clinical-care', legal_authority: 'tpo' } });
      expect(await ask(w, { purpose: 'clinical-care' })).toMatchObject({ eligible: true, reason_codes: [], legal_authority: 'tpo' });
    });

    it('is eligible for an evaluation fact, and not for the same id asked as a capture', async () => {
      const w = await world();
      await setup(w);
      const evaluationId = await evaluate(w);
      expect(await ask(w, { factKind: 'evaluation', factId: evaluationId })).toMatchObject({ eligible: true, reason_codes: [] });
      expect(await ask(w, { factKind: 'capture', factId: evaluationId })).toMatchObject({ eligible: false, reason_codes: ['origin-unknown'] });
    });

    // Each case writes the records it needs and names the only reason code that may come back.
    const cases: Array<[string, string, (w: World) => Promise<{ ids?: Ids; over?: Partial<Parameters<typeof askUse>[2]> } | void>]> = [
      ['unknown-purpose', 'a purpose outside the vocabulary (no model-* purposes)', async (w) => ({ ids: await setup(w), over: { purpose: 'model-training' } })],
      ['unknown-classification', 'a classification outside the four', async (w) => ({ ids: await setup(w), over: { classification: 'phi' } })],
      ['no-terms-in-force', 'no terms recorded', async (w) => ({ ids: await setup(w, { terms: false }) })],
      ['terms-purpose-not-authorized', 'terms that do not authorize the purpose', async (w) => ({ ids: await setup(w, { terms: { authorized_purposes: ['clinical-care'] } }) })],
      [
        'terms-classification-not-authorized',
        'terms that do not authorize the classification',
        async (w) => ({ ids: await setup(w, { terms: { authorized_classifications: ['de-identified'] } }) }),
      ],
      ['no-grant', 'no grant for the purpose and scope', async (w) => ({ ids: await setup(w, { grant: false }) })],
      ['grant-not-yet-effective', 'a grant effective tomorrow', async (w) => ({ ids: await setup(w, { grant: { effective_from: when(DAY), expires_at: when(2 * DAY) } }) })],
      ['grant-expired', 'a grant that expired yesterday', async (w) => ({ ids: await setup(w, { grant: { effective_from: when(-2 * DAY), expires_at: when(-DAY) } }) })],
      ['grant-withdrawn', 'a grant withdrawn effective when recorded', async (w) => ({ ids: await setup(w, { withdrawal: {} }) })],
      ['grant-unvalidated', 'a grant nobody validated', async (w) => ({ ids: await setup(w, { validate: false }) })],
      ['restriction-in-force', 'a restriction on this purpose', async (w) => ({ ids: await setup(w, { restriction: { purpose: 'research' } }) })],
      ['jurisdiction-not-allowed', 'a grant whose jurisdiction is not on the allowlist', async (w) => ({ ids: await setup(w, { grant: { jurisdiction: 'US' } }) })],
      ['origin-unknown', 'a fact id that does not exist', async (w) => ({ ids: await setup(w), over: { factId: randomUUID() } })],
    ];
    it.each(cases)('%s: %s', async (code, _what, build) => {
      const w = await world();
      const built = (await build(w)) ?? {};
      const answer = await ask(w, built.over);
      expect(answer).toMatchObject({ eligible: false, reason_codes: [code], policy_version: 'use-eligibility-v1' });
    });

    it('origin-unknown for a fact with NO provenance row (stored before 0062), written the way the previous release wrote it', async () => {
      const w = await world();
      await setup(w);
      const old = await Session.open(db.appUrl, 'use-old-capture', w.tenant, w.report.uploader);
      const other = await seedLabReport(db.adminUrl, w.tenant);
      const id = await old.insertCapture(other); // a capture and its event, no provenance
      await old.client.query('COMMIT');
      await old.close();
      expect(await rows(`SELECT count(*)::int AS n FROM data_provenance WHERE capture_id = $1`, [id])).toEqual([{ n: 0 }]);
      const grantForOther = grantRow(w.tenant, other.patientId, RECORDER);
      await writeUseRecord(db.appUrl, 'use_grants', grantForOther);
      await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grantForOther.id as string, VALIDATOR));
      expect(await askUse(db.appUrl, w.tenant, { patient: other.patientId, purpose: 'research', factId: id, at: await now() })).toMatchObject({
        eligible: false,
        reason_codes: ['origin-unknown'],
      });
    });

    it('origin-unknown for another patient’s fact, an evaluation id asked as a capture, and an unknown fact kind', async () => {
      const w = await world();
      await setup(w);
      const other = await world(); // a different organization's capture
      const sameTenant = await seedLabReport(db.adminUrl, w.tenant); // and a different patient of the same organization
      const stored = await repo.insertCapture(w.tenant, sameTenant.uploader, captureFor(sameTenant));
      expect(await ask(w)).toMatchObject({ eligible: true }); // control: the patient's own fact
      expect(await ask(w, { factId: stored.record.id as string })).toMatchObject({ eligible: false, reason_codes: ['origin-unknown'] });
      expect(await ask(w, { factId: other.captureId })).toMatchObject({ eligible: false, reason_codes: ['origin-unknown'] });
      expect(await ask(w, { factKind: 'evaluation' })).toMatchObject({ eligible: false, reason_codes: ['origin-unknown'] });
      expect(await ask(w, { factKind: 'report' })).toMatchObject({ eligible: false, reason_codes: ['origin-unknown'] });
    });

    it('origin-not-allowed: real data is allowed for clinical care only (FR-07)', async () => {
      const w = await world('real');
      await setup(w);
      expect(await ask(w)).toMatchObject({ eligible: false, reason_codes: ['origin-not-allowed'] });
      for (const purpose of PURPOSES.filter((p) => p !== 'clinical-care' && p !== 'research')) {
        const grant = grantRow(w.tenant, w.patient, RECORDER, { purpose });
        await writeUseRecord(db.appUrl, 'use_grants', grant);
        await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grant.id as string, VALIDATOR));
        expect(await ask(w, { purpose })).toMatchObject({ eligible: false, reason_codes: ['origin-not-allowed'] });
      }
    });

    it('reports every reason that applies, sorted', async () => {
      const w = await world('real');
      await setup(w, { terms: false, validate: false, grant: { jurisdiction: 'US' }, restriction: { purpose: 'all' } });
      const answer = await ask(w);
      expect(answer.reason_codes).toEqual(['grant-unvalidated', 'jurisdiction-not-allowed', 'no-terms-in-force', 'origin-not-allowed', 'restriction-in-force']);
      expect(answer.eligible).toBe(false);
      expect(answer.legal_authority).toBe('authorization'); // the grant relied on is reported even when it fails
    });

    it('refuses a tenant other than the transaction’s, and a missing instant', async () => {
      const w = await world();
      await setup(w);
      const elsewhere = `t-${randomUUID().slice(0, 8)}`;
      const asOther = await attempt(db.appUrl, elsewhere, RECORDER, (c) =>
        c.query(`SELECT * FROM use_eligibility($1, $2, 'research', 'syn-program-1', 'identifiable', 'capture', $3, now())`, [w.tenant, w.patient, w.captureId]),
      );
      expect(asOther?.code).toBe('42501');
      const noInstant = await attempt(db.appUrl, w.tenant, RECORDER, (c) =>
        c.query(`SELECT * FROM use_eligibility($1, $2, 'research', 'syn-program-1', 'identifiable', 'capture', $3, NULL)`, [w.tenant, w.patient, w.captureId]),
      );
      expect(noInstant?.code).toBe('22023');
      // Positive control: the same call for the bound tenant answers.
      const ok = await attempt(db.appUrl, w.tenant, RECORDER, (c) =>
        c.query(`SELECT * FROM use_eligibility($1, $2, 'research', 'syn-program-1', 'identifiable', 'capture', $3, now())`, [w.tenant, w.patient, w.captureId]),
      );
      expect(ok).toBeUndefined();
    });

    it('another organization’s grants and terms are invisible to the policy (row-level security under SECURITY INVOKER)', async () => {
      const a = await world();
      await setup(a);
      const b = await world();
      expect(await ask(b)).toMatchObject({ eligible: false, reason_codes: ['no-grant', 'no-terms-in-force'] });
      expect(await ask(a)).toMatchObject({ eligible: true });
    });

    it('applies the interval controls: a restriction on another purpose or one that ended, and a withdrawal not yet effective, do not stop a use', async () => {
      const w = await world();
      await setup(w, {
        restriction: { purpose: 'payer-program' },
        withdrawal: { effective_at: when(60 * 60 * 1000) },
      });
      await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, { effective_from: when(-3 * DAY), effective_until: when(-2 * DAY) }));
      expect(await ask(w)).toMatchObject({ eligible: true, reason_codes: [] });
      expect(await ask(w, { at: when(2 * 60 * 60 * 1000) })).toMatchObject({ eligible: false, reason_codes: ['grant-withdrawn'] });
    });

    it('relies on the newest usable grant: a fresh grant after a withdrawal makes the patient eligible again', async () => {
      const w = await world();
      await setup(w, { withdrawal: {} });
      expect((await ask(w)).reason_codes).toEqual(['grant-withdrawn']);
      const again = grantRow(w.tenant, w.patient, RECORDER);
      await writeUseRecord(db.appUrl, 'use_grants', again);
      await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, again.id as string, VALIDATOR));
      const answer = await ask(w);
      expect(answer).toMatchObject({ eligible: true, reason_codes: [] });
      expect(answer.evidence_ids).toContain(again.id);
    });

    it('a research grant may have no expiration (B5), and answers eligible far in the future', async () => {
      const w = await world();
      await setup(w, { grant: { expiry_kind: 'no-expiration', expires_at: null } });
      expect(await ask(w, { at: when(36_500 * DAY) })).toMatchObject({ eligible: true });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // T205: replay. An answer for a past instant is reproduced after later records exist, including a later grant with a back-dated start.
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  describe('replay (T205): "as of at, knowing only what was recorded by at"', () => {
    it('reproduces every answer on a synthetic timeline after all later records exist', async () => {
      const w = await world();
      const marks: Array<{ label: string; at: string; expected: string[]; first?: Answer }> = [];
      const mark = async (label: string, expected: string[]) => marks.push({ label, at: await now(), expected });

      await mark('before anything is recorded', ['no-grant', 'no-terms-in-force']);
      await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator'));
      await mark('terms recorded', ['no-grant']);
      const g1 = grantRow(w.tenant, w.patient, RECORDER);
      await writeUseRecord(db.appUrl, 'use_grants', g1);
      await mark('grant recorded, not validated', ['grant-unvalidated']);
      await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, g1.id as string, VALIDATOR));
      await mark('grant validated', []);
      await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, { purpose: 'research' }));
      await mark('restriction recorded', ['restriction-in-force']);
      await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, g1.id as string, RECORDER));
      await mark('grant withdrawn', ['grant-withdrawn', 'restriction-in-force']);
      // A LATER grant with a start long before everything above. Had it existed then, the earlier answers would differ; it did not, so they must not.
      const g2 = grantRow(w.tenant, w.patient, RECORDER, { effective_from: when(-30 * DAY) });
      await writeUseRecord(db.appUrl, 'use_grants', g2);
      await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, g2.id as string, VALIDATOR));
      await mark('back-dated grant recorded and validated', ['restriction-in-force']);

      // First pass: the answers as the table above says. Second pass: asked again, after every record exists, they are the same to the last field.
      for (const m of marks) {
        const answer = await askUse(db.appUrl, w.tenant, { patient: w.patient, purpose: 'research', factId: w.captureId, at: m.at });
        expect({ label: m.label, reasons: answer.reason_codes }).toEqual({ label: m.label, reasons: m.expected });
        m.first = answer;
      }
      const lastAt = await now();
      for (const m of marks) {
        const again = await askUse(db.appUrl, w.tenant, { patient: w.patient, purpose: 'research', factId: w.captureId, at: m.at });
        expect({ label: m.label, answer: again }).toEqual({ label: m.label, answer: m.first });
      }
      // And the present is different: the back-dated grant counts from the moment it was recorded.
      expect(await askUse(db.appUrl, w.tenant, { patient: w.patient, purpose: 'research', factId: w.captureId, at: lastAt })).toMatchObject({
        reason_codes: ['restriction-in-force'],
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // T206: the per-patient lock. A withdrawal racing a use is never missed.
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  describe('the per-patient lock (T206)', () => {
    async function lockedWorld() {
      const w = await world();
      const ids = await setup(w);
      return { w, ids };
    }
    const askAt = (s: Session, w: World, at: string) =>
      s.client.query<Answer>(`SELECT * FROM use_eligibility($1, $2, 'research', 'syn-program-1', 'identifiable', 'capture', $3, $4)`, [w.tenant, w.patient, w.captureId, at]);

    it('a withdrawal waits for the lock a use holds, and the use that asked first is entitled to its answer (positive control)', async () => {
      const { w, ids } = await lockedWorld();
      const use = await Session.open(db.appUrl, 'use-race-a1', w.tenant, 'syn-asker');
      const writer = await Session.open(db.appUrl, 'use-race-b1', w.tenant, RECORDER);
      try {
        const at = (await use.client.query<{ at: string }>(`SELECT use_eligibility_lock($1, $2)::text AS at`, [w.tenant, w.patient])).rows[0]!.at;
        let finished = false;
        const withdrawing = insertUseRecord(writer.client, 'use_withdrawals', withdrawalRow(w.tenant, ids.grant!, RECORDER)).then((r) => {
          finished = true;
          return r;
        });
        await untilBlocked(db.adminUrl, 'use-race-b1'); // the withdrawal is queued behind the use's lock
        expect(finished).toBe(false);
        expect((await askAt(use, w, at)).rows[0]).toMatchObject({ eligible: true, reason_codes: [] }); // the use runs under the lock, before the withdrawal
        await use.client.query('COMMIT');
        const written = await withdrawing; // released: the withdrawal goes through
        await writer.client.query('COMMIT');
        expect(Date.parse(written.createdAt)).toBeGreaterThan(Date.parse(at)); // recorded after the use's instant, so the use did not see it, rightly
        expect(await ask(w)).toMatchObject({ eligible: false, reason_codes: ['grant-withdrawn'] });
      } finally {
        await use.close();
        await writer.close();
      }
    });

    it('a use that asks after a withdrawal is recorded waits for it to commit, then never answers eligible', async () => {
      const { w, ids } = await lockedWorld();
      const writer = await Session.open(db.appUrl, 'use-race-b2', w.tenant, RECORDER);
      const use = await Session.open(db.appUrl, 'use-race-a2', w.tenant, 'syn-asker');
      try {
        const withdrawn = await insertUseRecord(writer.client, 'use_withdrawals', withdrawalRow(w.tenant, ids.grant!, RECORDER)); // holds the lock, uncommitted
        let got: string | undefined;
        const locking = use.client.query<{ at: string }>(`SELECT use_eligibility_lock($1, $2)::text AS at`, [w.tenant, w.patient]).then((r) => {
          got = r.rows[0]!.at;
        });
        await untilBlocked(db.adminUrl, 'use-race-a2'); // the use is queued behind the withdrawal
        expect(got).toBeUndefined();
        await writer.client.query('COMMIT');
        await locking;
        expect(Date.parse(got!)).toBeGreaterThan(Date.parse(withdrawn.createdAt)); // the instant is read after the lock: it sees the withdrawal as recorded
        const answer = (await askAt(use, w, got!)).rows[0]!; // a fresh statement
        expect(answer).toMatchObject({ eligible: false, reason_codes: ['grant-withdrawn'] });
        await use.client.query('COMMIT');
      } finally {
        await use.close();
        await writer.close();
      }
    });

    it('the lock is per patient: a withdrawal for another patient of the same organization does not wait (control)', async () => {
      const { w } = await lockedWorld();
      const otherReport = await seedLabReport(db.adminUrl, w.tenant);
      const otherGrant = grantRow(w.tenant, otherReport.patientId, RECORDER);
      await writeUseRecord(db.appUrl, 'use_grants', otherGrant);
      const use = await Session.open(db.appUrl, 'use-race-a3', w.tenant, 'syn-asker');
      const writer = await Session.open(db.appUrl, 'use-race-b3', w.tenant, RECORDER);
      try {
        await use.client.query(`SELECT use_eligibility_lock($1, $2)`, [w.tenant, w.patient]);
        await insertUseRecord(writer.client, 'use_withdrawals', withdrawalRow(w.tenant, otherGrant.id as string, RECORDER)); // returns without waiting
        await writer.client.query('COMMIT');
        await use.client.query('COMMIT');
      } finally {
        await use.close();
        await writer.close();
      }
    });

    it('the lock function is for the bound organization only', async () => {
      const { w } = await lockedWorld();
      const error = await attempt(db.appUrl, `t-${randomUUID().slice(0, 8)}`, RECORDER, (c) => c.query(`SELECT use_eligibility_lock($1, $2)`, [w.tenant, w.patient]));
      expect(error?.code).toBe('42501');
      expect(await attempt(db.appUrl, w.tenant, RECORDER, (c) => c.query(`SELECT use_eligibility_lock($1, $2)`, [w.tenant, w.patient]))).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // The records: constraints, triggers, append-only, FORCE RLS.
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  describe('the records', () => {
    async function direct(w: World, table: UseRecordTable, row: Row, sessionActor = RECORDER): Promise<PgError | undefined> {
      const s = await Session.open(db.appUrl, `use-direct-${randomUUID().slice(0, 6)}`, w.tenant, sessionActor);
      try {
        return await s.start(...insertSql(table, row));
      } finally {
        await s.close();
      }
    }

    describe('use_grants', () => {
      it('accepts a well-formed row (control), sets created_at itself and refuses to take it from the caller', async () => {
        const w = await world();
        const written = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { created_at: '2000-01-01T00:00:00Z' }));
        expect(Math.abs(Date.parse(written.createdAt) - Date.now())).toBeLessThan(60_000);
        expect(await rows(`SELECT recorded_by, created_by, purpose, legal_authority FROM use_grants WHERE tenant_id = $1`, [w.tenant])).toEqual([
          { recorded_by: RECORDER, created_by: RECORDER, purpose: 'research', legal_authority: 'authorization' },
        ]);
      });

      it.each([
        ['an unknown purpose', { purpose: 'model-training' }, 'use_grants_purpose'],
        ['a model-evaluation purpose (not planned)', { purpose: 'model-evaluation' }, 'use_grants_purpose'],
        ['a lower-case jurisdiction', { jurisdiction: 'zz' }, 'use_grants_jurisdiction'],
        ['a three-letter jurisdiction', { jurisdiction: 'ZZZ' }, 'use_grants_jurisdiction'],
        ['an unknown legal authority', { legal_authority: 'consent' }, 'use_grants_legal_authority'],
        ['a language that is not a tag', { language: 'English' }, 'use_grants_language'],
        ['a signer that looks like a name (a space)', { signer: 'Synthetic Person' }, 'use_grants_refs'],
        ['an empty scope', { scope: '' }, 'use_grants_refs'],
        ['`event` expiry (no program-end event is recorded yet, B5)', { expiry_kind: 'event', expires_at: null }, 'use_grants_expiry_kind'],
        ['`date` expiry with no date', { expiry_kind: 'date', expires_at: null }, 'use_grants_expiry_shape'],
        ['`no-expiration` that also names a date', { purpose: 'research', expiry_kind: 'no-expiration' }, 'use_grants_expiry_shape'],
        ['`no-expiration` for a purpose other than research', { purpose: 'clinical-care', expiry_kind: 'no-expiration', expires_at: null }, 'use_grants_no_expiration_research'],
        ['an expiry before the start', { effective_from: when(DAY), expires_at: when(-DAY) }, 'use_grants_expiry_after_start'],
        ['a signer capacity outside the two', { signer_capacity: 'guardian' }, 'use_grants_signer_capacity'],
        ['a representative with no authority evidence', { signer_capacity: 'legally-authorized-representative' }, 'use_grants_representative_evidence'],
        ['authority evidence for a patient signer', { authority_evidence_ref: 'syn-evidence-1' }, 'use_grants_representative_evidence'],
        ['a signed-document hash that is not a sha-256', { signed_document_sha256: 'xyz' }, 'use_grants_document_hash'],
      ])('%s is refused by its CHECK', async (_label, over, constraint) => {
        const w = await world();
        const row = grantRow(w.tenant, w.patient, RECORDER, over);
        // recorded_by differs from the actor only in the last case; the trigger would refuse it first, so that case is run with the actor it names.
        expect(await direct(w, 'use_grants', row)).toMatchObject({ code: '23514', constraint });
      });

      it('a recorder who is not the person bound to the transaction is refused by the trigger, before any CHECK', async () => {
        const w = await world();
        expect(await direct(w, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { recorded_by: 'syn-someone-else' }))).toMatchObject({ code: '42501' });
        expect(await direct(w, 'use_grants', grantRow(w.tenant, w.patient, 'syn-someone-else'))).toMatchObject({ code: '42501' });
      });

      it('a missing expiry kind is refused by NOT NULL, whether the column is left out or named as NULL', async () => {
        const w = await world();
        expect(await direct(w, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { expiry_kind: undefined }))).toMatchObject({ code: '23502', column: 'expiry_kind' });
        expect(await direct(w, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { expiry_kind: null }))).toMatchObject({ code: '23502', column: 'expiry_kind' });
      });

      it('a representative with authority evidence, and a research grant with no expiration, are accepted (controls)', async () => {
        const w = await world();
        await writeUseRecord(
          db.appUrl,
          'use_grants',
          grantRow(w.tenant, w.patient, RECORDER, {
            signer_capacity: 'legally-authorized-representative',
            authority_evidence_ref: 'syn-evidence-1',
            witness_or_attester: 'syn-witness-1',
          }),
        );
        await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { expiry_kind: 'no-expiration', expires_at: null, scope: 'syn-program-2' }));
      });

      it('a patient that does not exist in this organization is refused by the composite foreign key', async () => {
        const w = await world();
        const other = await world();
        expect(await direct(w, 'use_grants', grantRow(w.tenant, randomUUID(), RECORDER))).toMatchObject({ code: '23503', constraint: 'use_grants_patient_fk' });
        expect(await direct(w, 'use_grants', grantRow(w.tenant, other.patient, RECORDER))).toMatchObject({ code: '23503', constraint: 'use_grants_patient_fk' });
      });
    });

    describe('use_grant_validations', () => {
      it('is refused when the validator is the person who recorded the grant (no self-validation), and accepted from someone else (control)', async () => {
        const w = await world();
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
        expect(await direct(w, 'use_grant_validations', validationRow(w.tenant, grant.id, RECORDER), RECORDER)).toMatchObject({
          code: '23514',
          constraint: 'use_grant_validations_not_self',
        });
        await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grant.id, VALIDATOR));
      });

      it('allows at most one per grant', async () => {
        const w = await world();
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
        await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grant.id, VALIDATOR));
        expect(await direct(w, 'use_grant_validations', validationRow(w.tenant, grant.id, 'syn-validator-2'), 'syn-validator-2')).toMatchObject({
          code: '23505',
          constraint: 'use_grant_validations_once_uq',
        });
      });

      it('names a grant that exists in this organization', async () => {
        const w = await world();
        const other = await world();
        const foreign = await writeUseRecord(db.appUrl, 'use_grants', grantRow(other.tenant, other.patient, RECORDER));
        expect(await direct(w, 'use_grant_validations', validationRow(w.tenant, randomUUID(), VALIDATOR), VALIDATOR)).toMatchObject({
          code: '23503',
          constraint: 'use_grant_validations_grant_fk',
        });
        expect(await direct(w, 'use_grant_validations', validationRow(w.tenant, foreign.id, VALIDATOR), VALIDATOR)).toMatchObject({
          code: '23503',
          constraint: 'use_grant_validations_grant_fk',
        });
      });
    });

    describe('use_withdrawals', () => {
      it('is never effective before its recording time (back-dating is refused); effective when recorded or later is accepted (controls)', async () => {
        const w = await world();
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
        expect(await direct(w, 'use_withdrawals', withdrawalRow(w.tenant, grant.id, RECORDER, { effective_at: when(-60_000) }))).toMatchObject({
          code: '23514',
          constraint: 'use_withdrawals_not_backdated',
        });
        const second = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { scope: 'syn-program-2' }));
        const written = await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, second.id, RECORDER)); // null: effective when recorded
        expect(await rows(`SELECT effective_at = created_at AS same FROM use_withdrawals WHERE id = $1`, [written.id])).toEqual([{ same: true }]);
        const third = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER, { scope: 'syn-program-3' }));
        await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, third.id, RECORDER, { effective_at: when(DAY) }));
      });

      it('allows at most one per grant, and names a grant of this organization', async () => {
        const w = await world();
        const other = await world();
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
        const foreign = await writeUseRecord(db.appUrl, 'use_grants', grantRow(other.tenant, other.patient, RECORDER));
        await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, grant.id, RECORDER));
        expect(await direct(w, 'use_withdrawals', withdrawalRow(w.tenant, grant.id, RECORDER))).toMatchObject({ code: '23505', constraint: 'use_withdrawals_once_uq' });
        expect(await direct(w, 'use_withdrawals', withdrawalRow(w.tenant, randomUUID(), RECORDER))).toMatchObject({ code: '23503', constraint: 'use_withdrawals_grant_fk' });
        expect(await direct(w, 'use_withdrawals', withdrawalRow(w.tenant, foreign.id, RECORDER))).toMatchObject({ code: '23503', constraint: 'use_withdrawals_grant_fk' });
      });
    });

    describe('use_restrictions', () => {
      it.each([
        ['an unknown purpose', { purpose: 'model-training' }, 'use_restrictions_purpose'],
        ['an end before the start', { effective_from: when(DAY), effective_until: when(-DAY) }, 'use_restrictions_interval'],
        ['an unknown reason code', { reason_code: 'because' }, 'use_restrictions_reason_code'],
      ])('%s is refused by its CHECK', async (_label, over, constraint) => {
        const w = await world();
        expect(await direct(w, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, over))).toMatchObject({ code: '23514', constraint });
      });

      it('accepts each purpose and `all`, and both reason codes (controls); a patient of another organization is refused', async () => {
        const w = await world();
        for (const purpose of ['all', ...PURPOSES]) await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, { purpose }));
        await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER, { reason_code: 'jurisdiction-rule' }));
        const other = await world();
        expect(await direct(w, 'use_restrictions', restrictionRow(w.tenant, other.patient, RECORDER))).toMatchObject({ code: '23503', constraint: 'use_restrictions_patient_fk' });
      });
    });

    describe('tenant_use_terms', () => {
      it.each([
        ['an unknown purpose', { authorized_purposes: ['clinical-care', 'model-training'] }, 'tenant_use_terms_purposes'],
        ['no purposes', { authorized_purposes: [] }, 'tenant_use_terms_purposes'],
        ['an unknown classification', { authorized_classifications: ['phi'] }, 'tenant_use_terms_classifications'],
        ['no classifications', { authorized_classifications: [] }, 'tenant_use_terms_classifications'],
        ['an end before the start', { effective_from: when(DAY), effective_until: when(-DAY) }, 'tenant_use_terms_interval'],
        ['an agreement reference with a space', { agreement_ref: 'Synthetic Agreement' }, 'tenant_use_terms_refs'],
      ])('%s is refused by its CHECK', async (_label, over, constraint) => {
        const w = await world();
        expect(await direct(w, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator', over), 'syn-operator')).toMatchObject({ code: '23514', constraint });
      });

      it('allows one record per agreement and version', async () => {
        const w = await world();
        await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator', { agreement_ref: 'syn-agreement-1', agreement_version: 'v1' }));
        expect(
          await direct(w, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator', { agreement_ref: 'syn-agreement-1', agreement_version: 'v1' }), 'syn-operator'),
        ).toMatchObject({
          code: '23505',
          constraint: 'tenant_use_terms_once_uq',
        });
        await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator', { agreement_ref: 'syn-agreement-1', agreement_version: 'v2' })); // a new version is accepted
      });
    });

    /** One well-formed row of each table for a world, written and committed with its ledger event. */
    async function populate(w: World) {
      const terms = await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator'));
      const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
      const validation = await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grant.id, VALIDATOR));
      const withdrawal = await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, grant.id, RECORDER, { effective_at: when(DAY) }));
      const restriction = await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER));
      return { tenant_use_terms: terms.id, use_grants: grant.id, use_grant_validations: validation.id, use_withdrawals: withdrawal.id, use_restrictions: restriction.id };
    }
    const ACTORS: Record<UseRecordTable, string> = {
      use_grants: RECORDER,
      use_grant_validations: VALIDATOR,
      use_withdrawals: RECORDER,
      use_restrictions: RECORDER,
      tenant_use_terms: 'syn-operator',
    };

    it.each(USE_RECORD_TABLES)('%s: append-only for everyone (UPDATE, DELETE, TRUNCATE), the owner and a superuser included', async (table) => {
      const w = await world();
      const ids = await populate(w);
      await withAdmin(db.adminUrl, async (c) => {
        await expect(c.query(`UPDATE ${table} SET created_by = created_by WHERE tenant_id = $1`, [w.tenant])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [w.tenant])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: '23000' });
      });
      const app = new Client({ connectionString: db.appUrl });
      await app.connect();
      try {
        for (const sql of [`UPDATE ${table} SET created_by = created_by`, `DELETE FROM ${table}`, `TRUNCATE ${table}`])
          await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
      expect(await rows(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [ids[table]])).toEqual([{ n: 1 }]); // nothing above changed a row
    });

    it.each(USE_RECORD_TABLES)('%s: FORCE row-level security isolates organizations, with a positive control, and the actor and tenant are bound', async (table) => {
      expect(await rows(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table])).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const a = await world();
      const b = await world();
      await populate(a);
      await populate(b);
      const visible = async (tenant: string) => {
        const s = await Session.open(db.appUrl, `use-rls-${randomUUID().slice(0, 6)}`, tenant, RECORDER);
        try {
          return (await s.client.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`)).rows.map((r) => r.tenant_id);
        } finally {
          await s.close();
        }
      };
      expect(await visible(a.tenant)).toEqual([a.tenant]); // positive control: the organization's own row is there
      expect(await visible(b.tenant)).toEqual([b.tenant]);
      expect(await visible(`t-${randomUUID().slice(0, 8)}`)).toEqual([]);
      // A row for A written inside B's transaction, and a row by someone other than the bound person, are refused by the BEFORE INSERT trigger.
      const rowFor = (w: World, who: string): Row => {
        switch (table) {
          case 'use_grants':
            return grantRow(w.tenant, w.patient, who);
          case 'use_restrictions':
            return restrictionRow(w.tenant, w.patient, who);
          case 'tenant_use_terms':
            return termsRow(w.tenant, who);
          default:
            return {};
        }
      };
      if (table === 'use_grant_validations' || table === 'use_withdrawals') {
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(a.tenant, a.patient, RECORDER, { scope: 'syn-program-9' }));
        const make = (tenant: string, who: string) => (table === 'use_grant_validations' ? validationRow(tenant, grant.id, who) : withdrawalRow(tenant, grant.id, who));
        expect(await direct(b, table, make(a.tenant, ACTORS[table]), ACTORS[table])).toMatchObject({ code: '42501' }); // A's row in B's transaction
        expect(await direct(a, table, make(a.tenant, 'syn-someone-else'), ACTORS[table])).toMatchObject({ code: '42501' }); // someone other than the bound person
      } else {
        expect(await direct(b, table, rowFor(a, ACTORS[table]), ACTORS[table])).toMatchObject({ code: '42501' });
        expect(await direct(a, table, rowFor(a, 'syn-someone-else'), ACTORS[table])).toMatchObject({ code: '42501' });
      }
    });

    it('only the application role can write, and only the ledger roles read besides it; the policy functions are not public', async () => {
      const grants = await rows<{ grantee: string; priv: string; tbl: string }>(
        `SELECT grantee, privilege_type AS priv, table_name AS tbl FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY 3, 1, 2`,
        [USE_RECORD_TABLES],
      );
      for (const table of USE_RECORD_TABLES) {
        const own = grants.filter((g) => g.tbl === table && g.grantee.startsWith('telesphoros_')).map((g) => `${g.grantee}:${g.priv}`);
        expect(own.sort()).toEqual(['telesphoros_app:INSERT', 'telesphoros_app:SELECT', 'telesphoros_ledger:SELECT', 'telesphoros_ledger_verifier:SELECT']);
      }
      const eligibility = `'use_eligibility(text,uuid,text,text,text,text,uuid,timestamptz)'::regprocedure`;
      expect(
        await rows(
          `SELECT has_function_privilege('telesphoros_app', ${eligibility}, 'EXECUTE') AS app, has_function_privilege('telesphoros_ledger_verifier', ${eligibility}, 'EXECUTE') AS verifier,
                  has_function_privilege('telesphoros_app', 'use_eligibility_lock(text,uuid)'::regprocedure, 'EXECUTE') AS app_lock,
                  has_function_privilege('telesphoros_ledger_verifier', 'use_eligibility_lock(text,uuid)'::regprocedure, 'EXECUTE') AS verifier_lock,
                  (SELECT prosecdef FROM pg_proc WHERE oid = ${eligibility}) AS definer`,
        ),
      ).toEqual([{ app: true, verifier: false, app_lock: true, verifier_lock: false, definer: false }]);
    });

    it('has no column that stores a name or free text: every text column is a reference or a code bound to a pattern or a vocabulary', async () => {
      const columns = await rows<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY 1, ordinal_position`,
        [USE_RECORD_TABLES],
      );
      expect(columns.filter((c) => /name|email|phone|address|birth|note|comment|text|body|ssn/.test(c.column_name))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // FR-05: the ledger verifies a chain holding all five new event types.
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  describe('the ledger over the five new event types', () => {
    const verify = async (tenant: string) => {
      const verifier = LedgerVerifier.connect(db.verifierUrl);
      try {
        return await verifier.verify(tenant);
      } finally {
        await verifier.close();
      }
    };
    const ALTER: Array<[UseRecordTable, string, string]> = [
      ['use_grants', `SET scope = 'syn-altered'`, `SET scope = 'syn-program-1'`],
      ['use_grant_validations', `SET created_at = created_at + interval '1 second'`, `SET created_at = created_at - interval '1 second'`],
      ['use_withdrawals', `SET effective_at = effective_at + interval '1 second'`, `SET effective_at = effective_at - interval '1 second'`],
      ['use_restrictions', `SET reason_code = 'jurisdiction-rule'`, `SET reason_code = 'patient-requested'`],
      ['tenant_use_terms', `SET de_identification_authorized = true`, `SET de_identification_authorized = false`],
    ];
    const asReplica = (sql: string, values: unknown[]) =>
      withAdmin(db.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(sql, values);
        await c.query('COMMIT');
      });

    it('verifies a chain holding all five types, goes red when any one row is altered behind the triggers, and is ok again when it is restored', async () => {
      const w = await world();
      const ids = await (async () => {
        const terms = await writeUseRecord(db.appUrl, 'tenant_use_terms', termsRow(w.tenant, 'syn-operator'));
        const grant = await writeUseRecord(db.appUrl, 'use_grants', grantRow(w.tenant, w.patient, RECORDER));
        const validation = await writeUseRecord(db.appUrl, 'use_grant_validations', validationRow(w.tenant, grant.id, VALIDATOR));
        const withdrawal = await writeUseRecord(db.appUrl, 'use_withdrawals', withdrawalRow(w.tenant, grant.id, RECORDER));
        const restriction = await writeUseRecord(db.appUrl, 'use_restrictions', restrictionRow(w.tenant, w.patient, RECORDER));
        return { tenant_use_terms: terms.id, use_grants: grant.id, use_grant_validations: validation.id, use_withdrawals: withdrawal.id, use_restrictions: restriction.id };
      })();
      const types = await rows<{ event_type: string }>(`SELECT event_type FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`, [w.tenant]);
      expect(types.map((t) => t.event_type)).toEqual(['capture', 'data-provenance', 'tenant-use-terms', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction']);
      expect(await verify(w.tenant)).toMatchObject({ status: 'ok', failures: [], eventsChecked: 7 });

      for (const [table, change, restore] of ALTER) {
        const seq = (await rows<{ seq: string }>(`SELECT seq::text AS seq FROM ledger_events WHERE subject_id = $1`, [ids[table]]))[0]!.seq;
        await asReplica(`UPDATE ${table} ${change} WHERE id = $1`, [ids[table]]);
        const red = await verify(w.tenant);
        expect({ table, status: red.status, failures: red.failures }).toEqual({ table, status: 'failed', failures: [{ kind: 'payload-mismatch', seq }] });
        await asReplica(`UPDATE ${table} ${restore} WHERE id = $1`, [ids[table]]);
        expect({ table, ...(await verify(w.tenant)) }).toMatchObject({ table, status: 'ok', failures: [], eventsChecked: 7 });
      }
    }, 120_000);

    it('closes the type-to-table mapping for the five types, and refuses a row with no event at COMMIT', async () => {
      const w = await world();
      const row = termsRow(w.tenant, 'syn-operator');
      // A row with no event: the deferred constraint trigger refuses the transaction at COMMIT.
      const orphan = await attempt(db.appUrl, w.tenant, 'syn-operator', (c) => c.query(...insertSql('tenant_use_terms', row)));
      expect(['23000', '23503']).toContain(orphan?.code);
      expect(await rows(`SELECT count(*)::int AS n FROM tenant_use_terms WHERE tenant_id = $1`, [w.tenant])).toEqual([{ n: 0 }]);
      // The type-to-table mapping is closed.
      const wrong = await rows<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ledger_events_type_subject'`);
      for (const pair of [
        ['use-grant', 'use_grants'],
        ['use-grant-validation', 'use_grant_validations'],
        ['use-withdrawal', 'use_withdrawals'],
        ['use-restriction', 'use_restrictions'],
        ['tenant-use-terms', 'tenant_use_terms'],
      ])
        expect(wrong[0]!.def).toContain(`WHEN '${pair[0]}'::text THEN '${pair[1]}'::text`);
    });
  });

  // keep HASH referenced for fixtures that name a document digest
  it('uses a well-formed synthetic document digest in its fixtures', () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
