import type { StructuredPreview } from '@telesphoros/shared-types';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, withAdmin, type EphemeralDatabase } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { attempt, run } from './helpers/ledger-sql';
import { StructuredRevisionsRepository } from '../src/storage/structured-revisions.repository';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { LedgerVerifier } from '../src/ledger/verifier';
import { Database } from '../src/db/database';

const bytes = (name = 'resolved') => readFileSync(resolve(__dirname, '../../../data/fixtures/pgx-contracts', name, 'package.json'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(usingPostgres() && usingS3() ? describe : describe.skip)('stored structured laboratory revisions (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let laboratoryId: string;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    lab = new LabPipeline(app, db.adminUrl);
  }, 120_000);
  beforeEach(() => {
    laboratoryId = `syn-lab-${randomUUID()}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  const view = (who: Person, reportId: string) => lab.api().get(`/api/v1/reports/${reportId}/structured-preview`).set(bearer(who.token));
  const review = (who: Person, reportId: string, body: object) => lab.api().post(`/api/v1/reports/${reportId}/structured-preview/patient-link`).set(bearer(who.token)).send(body);
  async function uploaded(content = bytes(), complete = true, same?: { uploader: Person; reviewer: Person; patient: { id: string } }) {
    const source = JSON.parse(content.toString('utf8'));
    source.report.laboratoryId = laboratoryId;
    if (source.report.assay.state === 'provided') source.report.assay.manifest.laboratoryId = laboratoryId;
    content = Buffer.from(JSON.stringify(source));
    const uploader = same?.uploader ?? (await lab.person('uploader', ['clinician', 'reviewer']));
    const reviewer = same?.reviewer ?? (await lab.person('reviewer', ['reviewer']));
    const patient =
      same?.patient ??
      (
        await lab
          .api()
          .post('/api/v1/patients')
          .set(bearer(uploader.token))
          .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
          .expect(201)
      ).body;
    const report = (
      await lab
        .api()
        .post('/api/v1/reports')
        .set(bearer(uploader.token))
        .send({ patientId: patient.id, type: 'structured', filename: 'package.json', sizeBytes: content.length })
        .expect(201)
    ).body;
    if (complete) {
      const state = (await lab.api().get(`/api/v1/reports/${report.id}/upload-state`).set(bearer(uploader.token)).expect(200)).body;
      const attempt = (
        await lab
          .api()
          .post(`/api/v1/reports/${report.id}/upload-attempts`)
          .set(bearer(uploader.token))
          .send({ requestId: randomUUID(), revision: state.revision, contentType: 'application/json', sha256: sha(content) })
          .expect(201)
      ).body;
      await lab
        .api()
        .put(`/api/v1/reports/${report.id}/upload-attempts/${attempt.attemptId}/bytes`)
        .set(bearer(uploader.token))
        .set('X-Upload-Revision', attempt.revision)
        .set('Content-Type', 'application/json')
        .send(content.toString('utf8'))
        .expect(200);
    }
    return { uploader, reviewer, patient, report };
  }
  const confirm = (p: StructuredPreview) => ({
    patientId: p.patientId,
    sha256: p.source.sha256,
    objectVersion: p.source.objectVersion,
    sourcePatientReference: p.laboratoryReport.patientId,
    decision: 'verified',
    basisCode: 'documented-clinic-procedure',
  });

  const stored = (who: Person, id: string) => lab.api().get(`/api/v1/reports/${id}/structured-preview/record`).set(bearer(who.token));
  const save = (who: Person, id: string, body: object) => lab.api().post(`/api/v1/reports/${id}/structured-preview/record`).set(bearer(who.token)).send(body);
  async function verified(s: Awaited<ReturnType<typeof uploaded>>) {
    const p = (await view(s.uploader, s.report.id).expect(200)).body as StructuredPreview;
    const decision = (await review(s.reviewer, s.report.id, confirm(p)).expect(201)).body;
    return { patientId: p.patientId, ...p.source, sourcePatientReference: p.laboratoryReport.patientId, patientLinkDecisionId: decision.id };
  }
  it('stores source evidence, exposes normalized finding rows and replays without a second ledger event', async () => {
    const s = await uploaded();
    expect((await stored(s.uploader, s.report.id).expect(200)).body.state).toBe('not-recorded');
    const body = await verified(s);
    const first = (await save(s.uploader, s.report.id, body).expect(201)).body;
    expect(first).toMatchObject({ state: 'candidate-for-review', reasons: [], actionable: false, independentReviewRequired: true });
    expect(first.record.findingIds).toEqual(['syn-finding-a']);
    expect((await save(s.uploader, s.report.id, body).expect(200)).body).toEqual(first);
    const rows = await withAdmin(db.adminUrl, (c) =>
      c.query('SELECT gene, coverage, analytical_state, reported_call FROM structured_report_findings WHERE revision_id=$1', [first.record.id]),
    );
    expect(rows.rows).toEqual([
      {
        gene: 'GENEA',
        coverage: 'tested',
        analytical_state: 'resolved',
        reported_call: { kind: 'diplotype', originalText: '*A / *A', value: '*A/*A', phase: 'resolved', copyNumber: 2 },
      },
    ]);
    const events = await withAdmin(db.adminUrl, (c) =>
      c.query("SELECT count(*)::int AS n FROM ledger_events WHERE subject_id=$1 AND event_type='structured-report-revision'", [first.record.id]),
    );
    expect(events.rows).toEqual([{ n: 1 }]);
  });
  it('refuses unverified and stale preview bindings without storing evidence', async () => {
    const s = await uploaded();
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    await save(s.uploader, s.report.id, { patientId: p.patientId, ...p.source, sourcePatientReference: p.laboratoryReport.patientId, patientLinkDecisionId: randomUUID() }).expect(
      409,
    );
    const body = await verified(s);
    await save(s.uploader, s.report.id, { ...body, sha256: 'a'.repeat(64) }).expect(409);
    expect((await stored(s.uploader, s.report.id).expect(200)).body.record).toBeNull();
    await save(s.uploader, s.report.id, body).expect(201);
  });
  it('preserves changed same-revision evidence and holds the whole series', async () => {
    const s = await uploaded();
    await save(s.uploader, s.report.id, await verified(s)).expect(201);
    const changed = JSON.parse(bytes().toString('utf8'));
    changed.assessment = null;
    changed.report.limitations = ['A changed source at the same laboratory revision.'];
    const duplicate = await uploaded(Buffer.from(JSON.stringify(changed)), true, s);
    const result = (await save(duplicate.uploader, duplicate.report.id, await verified(duplicate)).expect(201)).body;
    expect(result).toMatchObject({ state: 'held', reasons: ['duplicate-revision-content'] });
    expect(result.history).toHaveLength(2);
    expect((await stored(s.uploader, s.report.id).expect(200)).body.state).toBe('held');
  });
  it('serializes concurrent saves to one immutable identity', async () => {
    const s = await uploaded();
    const body = await verified(s);
    const results = await Promise.all([save(s.uploader, s.report.id, body), save(s.reviewer, s.report.id, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].body.record.id).toBe(results[1].body.record.id);
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(1);
  });
  it('retains identical uploads as separate provenance without a conflict', async () => {
    const s = await uploaded();
    await save(s.uploader, s.report.id, await verified(s)).expect(201);
    const duplicate = await uploaded(bytes(), true, s);
    const result = (await save(s.uploader, duplicate.report.id, await verified(duplicate)).expect(201)).body;
    expect(result.state).toBe('candidate-for-review');
    expect(result.history).toHaveLength(2);
    expect(new Set(result.history.map((r: { id: string }) => r.id)).size).toBe(2);
  });
  it('holds an orphan amendment, then selects the complete latest revision without backfilling findings', async () => {
    const amended = JSON.parse(bytes('amended').toString());
    amended.assessment = null;
    amended.report.findings = [];
    const s = await uploaded(Buffer.from(JSON.stringify(amended)));
    const orphan = (await save(s.uploader, s.report.id, await verified(s)).expect(201)).body;
    expect(orphan).toMatchObject({ state: 'held', reasons: ['revision-gap'] });
    const older = await uploaded(bytes(), true, s);
    expect((await save(s.uploader, older.report.id, await verified(older)).expect(201)).body.state).toBe('superseded');
    const result = (await stored(s.uploader, s.report.id).expect(200)).body;
    expect(result).toMatchObject({ state: 'candidate-for-review', record: { findingIds: [] } });
    expect(result.history).toHaveLength(2);
  });
  it.each(['seriesId', 'accession', 'id'])('refuses cross-patient reuse of laboratory %s', async (identity) => {
    const s = await uploaded();
    await save(s.uploader, s.report.id, await verified(s)).expect(201);
    const other = JSON.parse(bytes().toString());
    other.assessment = null;
    for (const key of ['seriesId', 'accession', 'id']) if (key !== identity) other.report[key] = `syn-other-${key.toLowerCase()}`;
    const different = await uploaded(Buffer.from(JSON.stringify(other)));
    const failure = await save(different.uploader, different.report.id, await verified(different)).expect(409);
    expect(JSON.stringify(failure.body)).not.toContain(s.patient.id);
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [different.report.id])).toBe(0);
  });
  it('keeps a changed review in history and holds the series instead of reviving the older revision', async () => {
    const s = await uploaded();
    await save(s.uploader, s.report.id, await verified(s)).expect(201);
    const amended = await uploaded(bytes('amended'), true, s);
    const binding = await verified(amended);
    await save(s.uploader, amended.report.id, binding).expect(201);
    const p = (await view(s.reviewer, amended.report.id).expect(200)).body;
    await review(s.reviewer, amended.report.id, { ...confirm(p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
    const result = (await stored(s.uploader, s.report.id).expect(200)).body;
    expect(result).toMatchObject({ state: 'held', reasons: ['source-or-review-changed'] });
    expect(result.history).toHaveLength(2);
    expect(result.history.find((r: { reportId: string }) => r.reportId === amended.report.id).currentBinding).toBe(false);
    await save(s.uploader, amended.report.id, binding).expect(409);
  });
  it('preserves a deleted source in reconciliation and refuses new writes for it', async () => {
    const s = await uploaded();
    const body = await verified(s);
    await save(s.uploader, s.report.id, body).expect(201);
    const next = await uploaded(bytes('amended'), true, s);
    await save(s.uploader, next.report.id, await verified(next)).expect(201);
    await lab.api().delete(`/api/v1/reports/${s.report.id}`).set(bearer(s.uploader.token)).expect(204);
    await save(s.uploader, s.report.id, body).expect(404);
    const result = (await stored(s.uploader, next.report.id).expect(200)).body;
    expect(result).toMatchObject({ state: 'held', reasons: ['source-or-review-changed'] });
    expect(result.history).toHaveLength(2);
  });
  it('refuses stale repository input even when the earlier source preview was valid', async () => {
    const s = await uploaded();
    await verified(s);
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    await review(s.reviewer, s.report.id, { ...confirm(p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
    await expect(app.get(StructuredRevisionsRepository).save(lab.tenant, s.uploader.sub, p)).rejects.toMatchObject({ status: 409 });
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('checks roles, tenant scope and strict write shape', async () => {
    const s = await uploaded();
    const body = await verified(s);
    await lab.api().get(`/api/v1/reports/${s.report.id}/structured-preview/record`).expect(401);
    for (const role of ['reader', 'admin']) {
      const person = await lab.person('forbidden', [role]);
      await stored(person, s.report.id).expect(403);
      await save(person, s.report.id, body).expect(403);
    }
    const foreign = await lab.person('foreign', ['reviewer'], 'another-records-tenant');
    await stored(foreign, s.report.id).expect(404);
    await save(foreign, s.report.id, body).expect(404);
    for (const changed of [{ patientId: randomUUID() }, { objectVersion: 'stale' }, { sourcePatientReference: 'syn-other' }, { patientLinkDecisionId: randomUUID() }])
      await save(s.uploader, s.report.id, { ...body, ...changed }).expect(409);
    await save(s.uploader, s.report.id, { ...body, findings: [] }).expect(400);
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  async function rawRevision(s: Awaited<ReturnType<typeof uploaded>>) {
    await verified(s);
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    const id = randomUUID(),
      eventId = randomUUID();
    const sql = `INSERT INTO structured_report_revisions
      (id,tenant_id,created_by,ledger_event_id,report_id,patient_id,report_sha256,object_version,patient_link_decision_id,parser_version,laboratory_report)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pgx-synthetic-0.1',$10)`;
    const args = [id, lab.tenant, s.uploader.sub, eventId, s.report.id, s.patient.id, p.source.sha256, p.source.objectVersion, p.patientLink.decision.id, p.laboratoryReport];
    return { id, eventId, p, sql, args };
  }
  it('rolls back a revision without its ledger event at commit', async () => {
    const s = await uploaded();
    const raw = await rawRevision(s);
    const error = await attempt(db.appUrl, lab.tenant, s.uploader.sub, (c) => c.query(raw.sql, raw.args));
    expect(error?.code).toMatch(/^23/);
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('rechecks the patient-link decision at commit and rolls back the row and event together', async () => {
    const s = await uploaded();
    const raw = await rawRevision(s);
    const transaction = app.get(Database).withTenant(
      lab.tenant,
      async (c) => {
        await c.query(raw.sql, raw.args);
        await review(s.reviewer, s.report.id, { ...confirm(raw.p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
        await app.get(LedgerRecordsRepository).appendRecordEvent(c, lab.tenant, 'structured_report_revisions', raw.id, raw.eventId);
      },
      { actor: s.uploader.sub },
    );
    await expect(transaction).rejects.toMatchObject({ code: 'SR001' });
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
    expect(await lab.count('ledger_events', 'id=$1', [raw.eventId])).toBe(0);
  });
  it('refuses an author revoked after preview and before insert', async () => {
    const s = await uploaded();
    const raw = await rawRevision(s);
    await withAdmin(db.adminUrl, (owner) =>
      owner.query("UPDATE tenant_memberships SET status='removed',version=version+1 WHERE tenant_id=$1 AND sub=$2", [lab.tenant, s.uploader.sub]),
    );
    const transaction = app.get(Database).withTenant(
      lab.tenant,
      async (c) => {
        await c.query(raw.sql, raw.args);
        await app.get(LedgerRecordsRepository).appendRecordEvent(c, lab.tenant, 'structured_report_revisions', raw.id, raw.eventId);
      },
      { actor: s.uploader.sub },
    );
    await expect(transaction).rejects.toMatchObject({ code: '42501' });
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
    expect(await lab.count('ledger_events', 'id=$1', [raw.eventId])).toBe(0);
  });
  it('refuses a deleted patient even with a previously verified source', async () => {
    const s = await uploaded();
    const body = await verified(s);
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    // Ordinary deletion is already refused while reports exist. Exercise the defensive tombstone guard directly.
    await lab.api().delete(`/api/v1/patients/${s.patient.id}`).set(bearer(s.uploader.token)).expect(409);
    await withAdmin(db.adminUrl, async (c) => {
      await c.query('SET session_replication_role=replica');
      await c.query('UPDATE patients SET deleted_at=clock_timestamp() WHERE id=$1', [s.patient.id]);
    });
    await save(s.uploader, s.report.id, body).expect(404);
    await expect(app.get(StructuredRevisionsRepository).save(lab.tenant, s.uploader.sub, p)).rejects.toMatchObject({ status: 409 });
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('refuses a missing pinned object instead of saving unverified findings', async () => {
    const s = await uploaded();
    const body = await verified(s);
    const [row] = await lab.row<{ storage_key: string }>('SELECT storage_key FROM reports WHERE id=$1', [s.report.id]);
    await lab.deleteVersion(row.storage_key, body.objectVersion);
    await save(s.uploader, s.report.id, body).expect(409);
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('refuses a merged-away patient and preserves the original source association', async () => {
    const s = await uploaded();
    const body = await verified(s);
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    const target = await lab.patient(s.uploader);
    const decider = await lab.person('merge-decider', ['clinician']);
    const proposed = await lab
      .api()
      .post('/api/v1/patient-merges')
      .set(bearer(s.uploader.token))
      .send({ kind: 'merge', sourcePatientId: s.patient.id, targetPatientId: target, reasonCode: 'entered-twice' })
      .expect(201);
    await lab.api().post(`/api/v1/patient-merges/${proposed.body.id}/decision`).set(bearer(decider.token)).send({ decision: 'approved' }).expect(201);
    await save(s.uploader, s.report.id, body).expect(409);
    await expect(app.get(StructuredRevisionsRepository).save(lab.tenant, s.uploader.sub, p)).rejects.toMatchObject({ status: 409 });
    expect(await lab.count('structured_report_revisions', 'report_id=$1', [s.report.id])).toBe(0);
    expect(await lab.row('SELECT patient_id FROM reports WHERE id=$1', [s.report.id])).toEqual([{ patient_id: s.patient.id }]);
  });
  it('refuses a full registry and never silently truncates an oversized history', async () => {
    const s = await uploaded();
    const first = (await save(s.uploader, s.report.id, await verified(s)).expect(201)).body;
    const next = await uploaded(bytes('amended'), true, s);
    const body = await verified(next);
    // Seed the boundary directly as owner; no quota-heavy upload loop or fabricated passing ledger verdict.
    const seed = async (count: number) =>
      withAdmin(db.adminUrl, async (c) => {
        await c.query('SET session_replication_role=replica');
        await c.query(
          `INSERT INTO structured_report_revisions
        (id,tenant_id,created_by,ledger_event_id,report_id,patient_id,report_sha256,object_version,patient_link_decision_id,parser_version,laboratory_report)
        SELECT gen_random_uuid(),tenant_id,created_by,gen_random_uuid(),gen_random_uuid(),patient_id,report_sha256,object_version,patient_link_decision_id,parser_version,laboratory_report
        FROM structured_report_revisions CROSS JOIN generate_series(1,$2) WHERE id=$1`,
          [first.record.id, count],
        );
      });
    try {
      await seed(99);
      await save(s.uploader, next.report.id, body).expect(409);
      expect(await lab.count('structured_report_revisions', 'report_id=$1', [next.report.id])).toBe(0);
      expect((await stored(s.uploader, s.report.id).expect(200)).body.history).toHaveLength(100);
      await seed(1);
      const result = await stored(s.uploader, s.report.id).expect(409);
      expect(result.body.history).toBeUndefined();
    } finally {
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('SET session_replication_role=replica');
        await c.query('DELETE FROM structured_report_revisions WHERE patient_id=$1 AND id<>$2', [s.patient.id, first.record.id]);
      });
    }
  });
  it('applies RLS to finding rows and refuses all mutations, including owner mutations', async () => {
    const s = await uploaded();
    const first = (await save(s.uploader, s.report.id, await verified(s)).expect(201)).body;
    expect((await run(db.appUrl, lab.tenant, s.uploader.sub, (c) => c.query('SELECT gene FROM structured_report_findings WHERE revision_id=$1', [first.record.id]))).rows).toEqual([
      { gene: 'GENEA' },
    ]);
    expect((await run(db.appUrl, 'another-records-tenant', s.uploader.sub, (c) => c.query('SELECT * FROM structured_report_findings'))).rows).toEqual([]);
    expect(await attempt(db.workerUrl, lab.tenant, s.uploader.sub, (c) => c.query('SELECT * FROM structured_report_findings'))).toMatchObject({ code: '42501' });
    for (const sql of [
      'UPDATE structured_report_revisions SET parser_version=parser_version WHERE id=$1',
      'DELETE FROM structured_report_revisions WHERE id=$1',
      'TRUNCATE structured_report_revisions CASCADE',
    ])
      expect(await attempt(db.adminUrl, lab.tenant, s.uploader.sub, (c) => c.query(sql, sql.includes('$1') ? [first.record.id] : []))).toMatchObject({ code: '23000' });
    expect(await attempt(db.appUrl, lab.tenant, s.uploader.sub, (c) => c.query("UPDATE structured_report_findings SET gene='changed'"))).toMatchObject({ code: '55000' });
  });
  it('detects changed laboratory evidence in the ledger verifier', async () => {
    const s = await uploaded();
    const first = (await save(s.uploader, s.report.id, await verified(s)).expect(201)).body;
    const verifier = LedgerVerifier.connect(db.verifierUrl);
    const original = (await withAdmin(db.adminUrl, (c) => c.query('SELECT laboratory_report FROM structured_report_revisions WHERE id=$1', [first.record.id]))).rows[0]
      .laboratory_report;
    try {
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('SET session_replication_role=replica');
        await c.query("UPDATE structured_report_revisions SET laboratory_report=jsonb_set(laboratory_report,'{limitations}','[\"Changed evidence\"]') WHERE id=$1", [
          first.record.id,
        ]);
      });
      const verdict = await verifier.verify(lab.tenant);
      expect(verdict.status).toBe('failed');
      expect(verdict.failures).toContainEqual(expect.objectContaining({ kind: 'payload-mismatch' }));
    } finally {
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('SET session_replication_role=replica');
        await c.query('UPDATE structured_report_revisions SET laboratory_report=$2 WHERE id=$1', [first.record.id, original]);
      });
      await verifier.close();
    }
  });
});
