import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PatientLinkUnverifiedError, SourceChangedError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport, sha } from '../helpers/ledger-fixtures';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Patient identifiers and the report-to-patient decision, at the database (migration 0020): what the application login may and may not do, the
 * rules the tables enforce on their own, and the repository's rules at the moment of storing an evaluation.
 */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const digest = () => randomBytes(32);
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);

async function asApplication<T>(tenantId: string | null, actor: string | null, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pg.appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    if (actor !== null) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const addIdentifier = (t: string, patientId: string, over: { system?: string; digest?: Buffer; status?: string } = {}) =>
  owner(
    async (c) =>
      (
        await c.query(
          `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by) VALUES ($1, $2, $3, $4, 'syn-registrar') RETURNING id::text AS id`,
          [t, patientId, over.system ?? 'hospital-a-mrn', over.digest ?? digest()],
        )
      ).rows[0].id as string,
  );

describe('patient_identifiers', () => {
  it('lets the application login read and register within its own organization, and withdraw by the one permitted update', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const id = await asApplication(
      t,
      'syn-clinician',
      async (c) =>
        (
          await c.query(
            `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by) VALUES ($1, $2, 'hospital-a-mrn', $3, 'syn-clinician') RETURNING id::text AS id`,
            [t, r.patientId, digest()],
          )
        ).rows[0].id as string,
    );
    expect((await asApplication(t, 'syn-clinician', (c) => c.query('SELECT id FROM patient_identifiers'))).rows).toEqual([{ id }]);
    await asApplication(t, 'syn-clinician', (c) =>
      c.query(`UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = 'syn-clinician', withdrawn_at = now() WHERE id = $1`, [id]),
    );
    expect((await owner((c) => c.query(`SELECT status, withdrawn_by FROM patient_identifiers WHERE id = $1`, [id]))).rows[0]).toEqual({
      status: 'withdrawn',
      withdrawn_by: 'syn-clinician',
    });
  });

  it('refuses the application login every other change: editing a column, deleting, truncating (42501)', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const id = await addIdentifier(t, r.patientId);
    for (const sql of [
      `UPDATE patient_identifiers SET value_digest = decode(repeat('00', 32), 'hex') WHERE id = '${id}'`,
      `UPDATE patient_identifiers SET system = 'other' WHERE id = '${id}'`,
      `UPDATE patient_identifiers SET patient_id = '${randomUUID()}' WHERE id = '${id}'`,
      `UPDATE patient_identifiers SET created_by = 'someone-else' WHERE id = '${id}'`,
      `DELETE FROM patient_identifiers WHERE id = '${id}'`,
      'TRUNCATE patient_identifiers',
    ]) {
      await expect(asApplication(t, 'syn-clinician', (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it("refuses even the owner a delete, a truncate, an edit of the digest, a second withdrawal, a return to active, and a withdrawal in another person's name than the one making the request", async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const id = await addIdentifier(t, r.patientId);
    await expect(owner((c) => c.query(`DELETE FROM patient_identifiers WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query('TRUNCATE patient_identifiers'))).rejects.toThrow(); // by the trigger, or because the decisions table references it: either way refused
    await expect(owner((c) => c.query('TRUNCATE patient_identifiers CASCADE'))).rejects.toThrow();
    expect((await owner((c) => c.query(`SELECT count(*)::int AS n FROM patient_identifiers WHERE id = $1`, [id]))).rows[0].n).toBe(1);
    await expect(owner((c) => c.query(`UPDATE patient_identifiers SET value_digest = decode(repeat('00', 32), 'hex') WHERE id = $1`, [id]))).rejects.toMatchObject({
      code: '23000',
    });
    await expect(
      asApplication(t, 'syn-clinician', (c) =>
        c.query(`UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = 'syn-impostor', withdrawn_at = now() WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23000' });
    await owner((c) => c.query(`UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = 'syn-ops', withdrawn_at = now() WHERE id = $1`, [id])); // control
    await expect(owner((c) => c.query(`UPDATE patient_identifiers SET withdrawn_by = 'syn-ops-2' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query(`UPDATE patient_identifiers SET status = 'active', withdrawn_by = NULL, withdrawn_at = NULL WHERE id = $1`, [id]))).rejects.toMatchObject({
      code: '23000',
    });
  });

  it('holds one number for one patient at a time: a second active row for the same organization, system and digest is refused; a withdrawn one frees it; another organization or system is separate', async () => {
    const t = tenant();
    const a = await seedLabReport(pg.adminUrl, t);
    const b = await seedLabReport(pg.adminUrl, t);
    const same = digest();
    const first = await addIdentifier(t, a.patientId, { digest: same });
    await expect(addIdentifier(t, b.patientId, { digest: same })).rejects.toMatchObject({ code: '23505', constraint: 'patient_identifiers_active_uq' });
    await expect(addIdentifier(t, a.patientId, { digest: same })).rejects.toMatchObject({ code: '23505' });
    await addIdentifier(t, b.patientId, { digest: same, system: 'hospital-b-mrn' }); // another authority
    const other = tenant();
    const c = await seedLabReport(pg.adminUrl, other);
    await addIdentifier(other, c.patientId, { digest: same }); // another organization
    await owner((cl) => cl.query(`UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = 'syn-ops', withdrawn_at = now() WHERE id = $1`, [first]));
    await addIdentifier(t, b.patientId, { digest: same }); // the withdrawn row no longer holds it
  });

  it('refuses malformed rows: an unsafe system code, a digest of the wrong size, a bad key version, a status that does not match the withdrawal columns', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    for (const bad of [
      { system: 'Hospital A' },
      { system: '-x' },
      { system: 'x-' },
      { system: '' },
      { system: 'a'.repeat(41) },
      { digest: randomBytes(31) },
      { digest: randomBytes(33) },
    ])
      await expect(addIdentifier(t, r.patientId, bad)).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner((c) =>
        c.query(`INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, key_version, created_by) VALUES ($1, $2, 'x', $3, 0, 'p')`, [
          t,
          r.patientId,
          digest(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner((c) =>
        c.query(`INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, status, created_by) VALUES ($1, $2, 'x', $3, 'withdrawn', 'p')`, [
          t,
          r.patientId,
          digest(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("is invisible to another organization and to a caller with none, and a row cannot be written for another organization or another organization's patient", async () => {
    const a = tenant();
    const b = tenant();
    const ra = await seedLabReport(pg.adminUrl, a);
    const rb = await seedLabReport(pg.adminUrl, b);
    await addIdentifier(a, ra.patientId);
    expect((await asApplication(b, 'syn', (c) => c.query('SELECT 1 FROM patient_identifiers'))).rows).toEqual([]);
    expect((await asApplication(null, null, (c) => c.query('SELECT 1 FROM patient_identifiers'))).rows).toEqual([]);
    await expect(
      asApplication(b, 'syn', (c) =>
        c.query(`INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by) VALUES ($1, $2, 'x', $3, 'syn')`, [a, ra.patientId, digest()]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(addIdentifier(b, ra.patientId)).rejects.toMatchObject({ code: '23503' }); // organization b, a's patient
    void rb;
  });
});

describe('report_patient_decisions: the rules the table enforces on its own', () => {
  /** An owner insert with an invented event id: the BEFORE INSERT rules raise first, so no ledger event is needed to prove a refusal. */
  const insert = (r: SeededReport, by: string, over: Record<string, unknown> = {}) => {
    const v = {
      report_id: r.reportId,
      patient_id: r.patientId,
      sha: r.pdfSha256,
      version: r.objectVersion,
      decision: 'verified',
      method: 'person-confirmed',
      basis: 'no-identifier-on-report',
      identifier: null,
      ...over,
    };
    return owner((c) =>
      c.query(
        `INSERT INTO report_patient_decisions (tenant_id, created_by, ledger_event_id, report_id, patient_id, report_sha256, object_version, decision, method, basis_code, identifier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.tenantId, by, randomUUID(), v.report_id, v.patient_id, v.sha, v.version, v.decision, v.method, v.basis, v.identifier],
      ),
    );
  };

  it("refuses the report's creator, its upload requester and its uploader, each alone (23000), and a bystander gets as far as the ledger check", async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t, { uploader: 'syn-creator', requestedBy: 'syn-requester', completedBy: 'syn-completer' });
    for (const by of ['syn-creator', 'syn-requester', 'syn-completer']) await expect(insert(r, by)).rejects.toMatchObject({ code: '23000' });
    // A different person passes this rule and then fails only because no ledger event describes the row (checked at commit).
    await expect(insert(r, 'syn-bystander')).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a decision about a file or patient the report does not have now, or about a report that is not uploaded', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const other = await seedLabReport(pg.adminUrl, t);
    // The table's own rule (23000), not the later ledger-event check (23503): a bystander with the RIGHT file gets as far as that one (see above).
    for (const over of [{ sha: sha('another file') }, { version: 'another-version' }, { patient_id: other.patientId }, { report_id: randomUUID() }]) {
      await expect(insert(r, 'syn-bystander', over)).rejects.toMatchObject({ code: '23000' });
    }
  });

  it("refuses shapes outside the frozen vocabulary (the table's own CHECK, with the row triggers off inside a rolled-back transaction so only the CHECK can speak): a match that is a rejection, an attestation without a reason or with the wrong list, a reason on a match, an identifier on an attestation", async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const id = await addIdentifier(t, r.patientId);
    const attempt = (over: Record<string, unknown>) =>
      owner(async (c) => {
        const v = { decision: 'verified', method: 'person-confirmed', basis: 'no-identifier-on-report', identifier: null, ...over };
        await c.query('BEGIN');
        try {
          await c.query('ALTER TABLE report_patient_decisions DISABLE TRIGGER USER');
          await c.query(
            `INSERT INTO report_patient_decisions (tenant_id, created_by, ledger_event_id, report_id, patient_id, report_sha256, object_version, decision, method, basis_code, identifier_id)
             VALUES ($1, 'syn-bystander', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [t, randomUUID(), r.reportId, r.patientId, r.pdfSha256, r.objectVersion, v.decision, v.method, v.basis, v.identifier],
          );
        } finally {
          await c.query('ROLLBACK');
        }
      });
    // Controls: every legal shape is accepted by the CHECK.
    await attempt({});
    await attempt({ decision: 'rejected', basis: 'different-person' });
    await attempt({ decision: 'rejected', basis: 'identifier-conflict' });
    await attempt({ decision: 'rejected', basis: 'cannot-establish' });
    await attempt({ basis: 'identifier-not-registered' });
    await attempt({ basis: 'documented-clinic-procedure' });
    await attempt({ method: 'identifier-match', identifier: id, basis: null });
    for (const over of [
      { method: 'identifier-match', decision: 'rejected', identifier: id, basis: null },
      { method: 'identifier-match', identifier: null, basis: null },
      { method: 'identifier-match', identifier: id, basis: 'no-identifier-on-report' },
      { basis: null },
      { basis: 'different-person' }, // a rejection reason on a verification
      { decision: 'rejected', basis: 'documented-clinic-procedure' }, // a verification reason on a rejection
      { basis: 'free text' },
      { identifier: id },
      { decision: 'maybe' },
      { method: 'guess' },
    ])
      await expect(attempt(over)).rejects.toMatchObject({ code: '23514' });
  });

  it("refuses a match that names a withdrawn identifier or another patient's (23000)", async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const other = await seedLabReport(pg.adminUrl, t);
    const withdrawn = await addIdentifier(t, r.patientId);
    await owner((c) => c.query(`UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = 'syn-ops', withdrawn_at = now() WHERE id = $1`, [withdrawn]));
    const foreign = await addIdentifier(t, other.patientId);
    await expect(insert(r, 'syn-bystander', { method: 'identifier-match', basis: null, identifier: withdrawn })).rejects.toMatchObject({ code: '23000' });
    await expect(insert(r, 'syn-bystander', { method: 'identifier-match', basis: null, identifier: foreign })).rejects.toMatchObject({ code: '23000' });
  });

  it('is append-only even for the owner, and tenant-isolated for the application login', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const stored = await repo.insertPatientDecision(t, 'syn-bystander', {
      reportId: r.reportId,
      expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion },
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'no-identifier-on-report',
    });
    for (const sql of [
      `UPDATE report_patient_decisions SET decision = 'rejected', basis_code = 'different-person' WHERE id = '${stored.record.id}'`,
      `DELETE FROM report_patient_decisions WHERE id = '${stored.record.id}'`,
      'TRUNCATE report_patient_decisions',
    ]) {
      await expect(owner((c) => c.query(sql))).rejects.toMatchObject({ code: '23000' });
    }
    expect((await asApplication(tenant(), 'syn', (c) => c.query('SELECT 1 FROM report_patient_decisions'))).rows).toEqual([]);
    expect((await asApplication(t, 'syn', (c) => c.query('SELECT 1 FROM report_patient_decisions'))).rows).toHaveLength(1);
  });
});

describe('the repository', () => {
  const expected = (r: SeededReport) => ({ patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion });
  const attest = { decision: 'verified', method: 'person-confirmed', basisCode: 'no-identifier-on-report' } as const;

  it('stores a decision with its ledger event and returns exactly what was hashed; the same decision again is the same record', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const first = await repo.insertPatientDecision(t, 'syn-bystander', { reportId: r.reportId, expectedReport: expected(r), ...attest });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({
      kind: 'patient-link-decision',
      reportId: r.reportId,
      patientId: r.patientId,
      reportSha256: r.pdfSha256,
      objectVersion: r.objectVersion,
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'no-identifier-on-report',
      identifierId: null,
    });
    const again = await repo.insertPatientDecision(t, 'syn-other', { reportId: r.reportId, expectedReport: expected(r), ...attest });
    expect([again.created, again.record.id]).toEqual([false, first.record.id]);
    const changed = await repo.insertPatientDecision(t, 'syn-other', {
      reportId: r.reportId,
      expectedReport: expected(r),
      decision: 'rejected',
      method: 'person-confirmed',
      basisCode: 'cannot-establish',
    });
    expect(changed.created).toBe(true);
    expect((await repo.latestPatientDecision(t, r.reportId))?.id).toBe(changed.record.id);
    expect(await repo.latestPatientDecision(tenant(), r.reportId)).toBeUndefined();
  });

  it('refuses (SourceChangedError) a decision about a file, patient or report that is not what the caller looked at, and writes nothing', async () => {
    const t = tenant();
    const r = await seedLabReport(pg.adminUrl, t);
    const other = await seedLabReport(pg.adminUrl, t);
    const before = (await owner((c) => c.query('SELECT count(*)::int AS n FROM report_patient_decisions'))).rows[0].n;
    for (const exp of [
      { ...expected(r), sha256: sha('another') },
      { ...expected(r), objectVersion: 'another-version' },
      { ...expected(r), patientId: other.patientId },
    ]) {
      await expect(repo.insertPatientDecision(t, 'syn-bystander', { reportId: r.reportId, expectedReport: exp, ...attest })).rejects.toBeInstanceOf(SourceChangedError);
    }
    await expect(repo.insertPatientDecision(t, 'syn-bystander', { reportId: randomUUID(), expectedReport: expected(r), ...attest })).rejects.toBeInstanceOf(SourceChangedError);
    await expect(repo.insertPatientDecision(tenant(), 'syn-bystander', { reportId: r.reportId, expectedReport: expected(r), ...attest })).rejects.toBeInstanceOf(
      SourceChangedError,
    );
    expect((await owner((c) => c.query('SELECT count(*)::int AS n FROM report_patient_decisions'))).rows[0].n).toBe(before);
  });

  describe('storing an evaluation that relies on a decision', () => {
    /** A report with an accepted capture, ready for an evaluation. */
    async function prepared() {
      const t = tenant();
      const r = await seedLabReport(pg.adminUrl, t);
      const capture = captureFor(r);
      const c = await repo.insertCapture(t, r.uploader, capture);
      const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
      const decide = (over: Partial<Parameters<typeof repo.insertPatientDecision>[2]> = {}, by = 'syn-bystander') =>
        repo.insertPatientDecision(t, by, { reportId: r.reportId, expectedReport: expected(r), ...attest, ...over });
      let n = 0;
      const evaluate = (relied?: string) =>
        repo.insertEvaluation(t, 'syn-system', {
          ...evaluationFor(r, c.record.id, a.record.id, { knowledgeSetId: sha(`ks-${++n}`) }),
          ...(relied === undefined ? {} : { patientLinkDecisionId: relied }),
        });
      return { t, r, decide, evaluate };
    }

    it('stores it when the named decision is the newest, says verified, and names the file and patient the report has now (control)', async () => {
      const p = await prepared();
      const d = await p.decide();
      expect((await p.evaluate(d.record.id)).created).toBe(true);
    });

    it('refuses (PatientLinkUnverifiedError) when a newer decision exists, when the decision is a rejection, when the file has changed, or when the id names no decision', async () => {
      const p = await prepared();
      const verified = await p.decide();
      const rejected = await p.decide({ decision: 'rejected', basisCode: 'different-person' }, 'syn-other');
      await expect(p.evaluate(verified.record.id)).rejects.toBeInstanceOf(PatientLinkUnverifiedError); // superseded by a newer decision
      await expect(p.evaluate(rejected.record.id)).rejects.toBeInstanceOf(PatientLinkUnverifiedError); // newest, but a rejection
      const again = await p.decide(attest, 'syn-third');
      await expect(p.evaluate(randomUUID())).rejects.toBeInstanceOf(PatientLinkUnverifiedError); // no such decision
      expect((await p.evaluate(again.record.id)).created).toBe(true); // control: now the newest, a verification, about this file
      const q = await prepared();
      const d = await q.decide();
      await owner(async (c) => {
        await c.query('BEGIN');
        await c.query('ALTER TABLE reports DISABLE TRIGGER USER'); // the product refuses to change an uploaded file; the owner can, once, on purpose
        await c.query(`UPDATE reports SET object_version = 'replaced' WHERE id = $1`, [q.r.reportId]);
        await c.query('ALTER TABLE reports ENABLE TRIGGER USER');
        await c.query('COMMIT');
      });
      await expect(q.evaluate(d.record.id)).rejects.toBeInstanceOf(PatientLinkUnverifiedError); // verified, but about the file the report no longer has
      expect((await owner((c) => c.query('SELECT count(*)::int AS n FROM evaluations WHERE tenant_id = $1', [q.t]))).rows[0].n).toBe(0); // and nothing was stored
    });

    it('does not look when no decision is named: only the evaluations service creates evaluations in production and it always names one', async () => {
      const p = await prepared();
      expect((await p.evaluate()).created).toBe(true);
    });
  });
});
