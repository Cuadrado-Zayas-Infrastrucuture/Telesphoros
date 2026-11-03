import type { StructuredPreview } from '@telesphoros/shared-types';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, withAdmin, type EphemeralDatabase } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { attempt } from './helpers/ledger-sql';
import { LedgerVerifier } from '../src/ledger/verifier';
import { Database } from '../src/db/database';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';

const bytes = (name = 'resolved') => readFileSync(resolve(__dirname, '../../../data/fixtures/pgx-contracts', name, 'package.json'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Uploaded = { uploader: Person; reviewer: Person; patient: { id: string }; report: { id: string } };

// The harness is a function so the describe block below can stay flat; it holds no state of its own.
function harness(get: () => { app: NestExpressApplication; db: EphemeralDatabase; lab: LabPipeline; laboratoryId: string }) {
  const view = (who: Person, reportId: string) => get().lab.api().get(`/api/v1/reports/${reportId}/structured-preview`).set(bearer(who.token));
  const link = (who: Person, reportId: string, body: object) =>
    get().lab.api().post(`/api/v1/reports/${reportId}/structured-preview/patient-link`).set(bearer(who.token)).send(body);
  async function uploaded(content = bytes(), same?: { uploader: Person; reviewer: Person; patient: { id: string } }): Promise<Uploaded> {
    const { lab, laboratoryId } = get();
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
    const state = (await lab.api().get(`/api/v1/reports/${report.id}/upload-state`).set(bearer(uploader.token)).expect(200)).body;
    const attemptBody = (
      await lab
        .api()
        .post(`/api/v1/reports/${report.id}/upload-attempts`)
        .set(bearer(uploader.token))
        .send({ requestId: randomUUID(), revision: state.revision, contentType: 'application/json', sha256: sha(content) })
        .expect(201)
    ).body;
    await lab
      .api()
      .put(`/api/v1/reports/${report.id}/upload-attempts/${attemptBody.attemptId}/bytes`)
      .set(bearer(uploader.token))
      .set('X-Upload-Revision', attemptBody.revision)
      .set('Content-Type', 'application/json')
      .send(content.toString('utf8'))
      .expect(200);
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
  const record = (who: Person, id: string) => get().lab.api().get(`/api/v1/reports/${id}/structured-preview/record`).set(bearer(who.token));
  const save = (who: Person, id: string, body: object) => get().lab.api().post(`/api/v1/reports/${id}/structured-preview/record`).set(bearer(who.token)).send(body);
  const review = (who: Person, id: string, body: object) => get().lab.api().post(`/api/v1/reports/${id}/structured-preview/review`).set(bearer(who.token)).send(body);
  const resolve_ = (who: Person, id: string, body: object) => get().lab.api().post(`/api/v1/reports/${id}/structured-preview/source-resolution`).set(bearer(who.token)).send(body);
  /** Verify the patient link and store the revision; returns the exact binding a reviewer must echo. */
  async function stored(s: Uploaded) {
    const p = (await view(s.uploader, s.report.id).expect(200)).body as StructuredPreview;
    const decision = (await link(s.reviewer, s.report.id, confirm(p)).expect(201)).body;
    const binding = { patientId: p.patientId, sha256: p.source.sha256, objectVersion: p.source.objectVersion, patientLinkDecisionId: decision.id };
    const state = (await save(s.uploader, s.report.id, { ...binding, sourcePatientReference: p.laboratoryReport.patientId }).expect(201)).body;
    return { binding, state, revisionId: state.record.id as string, p };
  }
  const accept = (e: { binding: object; revisionId: string }, over: object = {}) => ({
    requestId: randomUUID(),
    revisionId: e.revisionId,
    ...e.binding,
    findingId: 'syn-finding-a',
    decision: 'accepted-as-evidence',
    reasonCode: 'matches-source',
    ...over,
  });
  const conflicting = async (s: Uploaded): Promise<Uploaded> => {
    const changed = JSON.parse(bytes().toString('utf8'));
    changed.assessment = null;
    changed.report.limitations = ['A changed source at the same laboratory revision.'];
    return uploaded(Buffer.from(JSON.stringify(changed)), s);
  };
  const resolution = (a: { revisionId: string }, b: { revisionId: string }, s: Uploaded, over: object = {}) => ({
    requestId: randomUUID(),
    patientId: s.patient.id,
    laboratoryId: get().laboratoryId,
    seriesId: 'syn-series-1',
    revision: 1,
    revisionIds: [a.revisionId, b.revisionId],
    outcome: 'use-revision',
    chosenRevisionId: b.revisionId,
    reasonCode: 'verified-against-laboratory',
    ...over,
  });
  return { view, link, uploaded, confirm, record, save, review, resolve_, stored, accept, conflicting, resolution };
}

(usingPostgres() && usingS3() ? describe : describe.skip)('independent findings review and source resolution (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let laboratoryId: string;
  const h = harness(() => ({ app, db, lab, laboratoryId }));
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
  const seriesOf = async (s: Uploaded) => (await h.record(s.uploader, s.report.id).expect(200)).body.record.seriesId as string;

  it('shows stored findings with provenance as awaiting independent review, then records an append-only acceptance', async () => {
    const s = await h.uploaded();
    const e = await h.stored(s);
    expect(e.state.review).toMatchObject({
      status: 'awaiting-review',
      outstanding: ['review-findings'],
      evidenceOnly: true,
      findings: [{ findingId: 'syn-finding-a', gene: 'GENEA', coverage: 'tested', decision: 'unreviewed', actionable: false }],
    });
    const body = h.accept(e);
    const first = await h.review(s.reviewer, s.report.id, body).expect(201);
    expect(first.body.review).toMatchObject({ status: 'complete', outstanding: [], findings: [{ decision: 'accepted-as-evidence', reasonCode: 'matches-source' }] });
    expect(first.body).toMatchObject({ actionable: false, clinicalUse: 'not-approved', independentReviewRequired: true });
    expect((await h.review(s.reviewer, s.report.id, body).expect(200)).body).toEqual(first.body);
    await h.review(s.reviewer, s.report.id, { ...body, decision: 'rejected', reasonCode: 'does-not-match-source' }).expect(409);
    expect(await lab.count('structured_finding_reviews', 'revision_id=$1', [e.revisionId])).toBe(1);
    expect(await lab.count('ledger_events', "event_type='structured-finding-review' AND tenant_id=$1", [lab.tenant])).toBe(1);
    // Patient matching is a separate record: reviewing findings must not add or change a patient-link decision.
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(1);
  });
  it('keeps uncertainty when an ambiguous finding is accepted as evidence', async () => {
    const s = await h.uploaded(bytes('uncertain'));
    const e = await h.stored(s);
    const result = (await h.review(s.reviewer, s.report.id, h.accept(e)).expect(201)).body;
    expect(result.review.findings[0]).toMatchObject({ analyticalState: 'ambiguous', interpretationState: 'indeterminate', decision: 'accepted-as-evidence', actionable: false });
    const rows = await lab.row<{ analytical_state: string; interpretation_state: string }>(
      'SELECT analytical_state,interpretation_state FROM structured_report_findings WHERE revision_id=$1',
      [e.revisionId],
    );
    expect(rows).toEqual([{ analytical_state: 'ambiguous', interpretation_state: 'indeterminate' }]);
  });
  it('appends a later decision without erasing the earlier one; the latest decides the status', async () => {
    const s = await h.uploaded();
    const e = await h.stored(s);
    await h.review(s.reviewer, s.report.id, h.accept(e)).expect(201);
    const held = (await h.review(s.reviewer, s.report.id, h.accept(e, { decision: 'held', reasonCode: 'needs-clarification' })).expect(201)).body;
    expect(held.review).toMatchObject({ status: 'attention', outstanding: ['reopen-held-findings'] });
    expect(await lab.count('structured_finding_reviews', 'revision_id=$1', [e.revisionId])).toBe(2);
  });
  it('requires a different reviewer, the reviewer role, tenant scope and a strict exact binding', async () => {
    const s = await h.uploaded();
    const e = await h.stored(s);
    await h.review(s.uploader, s.report.id, h.accept(e)).expect(409); // saved and uploaded the evidence
    for (const role of ['reader', 'admin', 'clinician']) await h.review(await lab.person('forbidden', [role]), s.report.id, h.accept(e)).expect(403);
    await h.review(await lab.person('foreign', ['reviewer'], 'another-records-tenant'), s.report.id, h.accept(e)).expect(404);
    for (const changed of [
      { revisionId: randomUUID() },
      { patientId: randomUUID() },
      { sha256: 'a'.repeat(64) },
      { objectVersion: 'stale' },
      { patientLinkDecisionId: randomUUID() },
      { findingId: 'syn-finding-missing' },
    ])
      await h.review(s.reviewer, s.report.id, h.accept(e, changed)).expect(409);
    await h.review(s.reviewer, s.report.id, { ...h.accept(e), extra: true }).expect(400);
    await h.review(s.reviewer, s.report.id, h.accept(e, { decision: 'accepted-as-evidence', reasonCode: 'source-uncertain' })).expect(400);
    expect(await lab.count('structured_finding_reviews', 'revision_id=$1', [e.revisionId])).toBe(0);
  });
  it('holds a reviewed record when the patient link later changes, and refuses new decisions on it', async () => {
    const s = await h.uploaded();
    const e = await h.stored(s);
    await h.review(s.reviewer, s.report.id, h.accept(e)).expect(201);
    await h.link(s.reviewer, s.report.id, { ...h.confirm(e.p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
    const result = (await h.record(s.uploader, s.report.id).expect(200)).body;
    expect(result).toMatchObject({ state: 'held', reasons: ['source-or-review-changed'], review: { status: 'not-reviewable', outstanding: ['recheck-changed-binding'] } });
    await h.review(s.reviewer, s.report.id, h.accept(e)).expect(409);
  });
  it('does not review a superseded revision or revive it', async () => {
    const s = await h.uploaded();
    const older = await h.stored(s);
    const amended = await h.uploaded(bytes('amended'), s);
    const newer = await h.stored(amended);
    await h.review(s.reviewer, s.report.id, h.accept(older)).expect(409);
    expect((await h.record(s.uploader, s.report.id).expect(200)).body).toMatchObject({ state: 'superseded', review: { status: 'not-reviewable', outstanding: [] } });
    await h.review(s.reviewer, amended.report.id, h.accept(newer)).expect(201);
    expect(await lab.count('structured_finding_reviews', 'revision_id=$1', [older.revisionId])).toBe(0);
  });

  describe('conflicting sources', () => {
    async function conflict() {
      const s = await h.uploaded();
      const a = await h.stored(s);
      const second = await h.conflicting(s);
      const b = await h.stored(second);
      return { s, second, a, b };
    }
    it('holds the series, reports the exact conflict set, and refuses finding review until it is resolved', async () => {
      const { s, a, b } = await conflict();
      const state = (await h.record(s.uploader, s.report.id).expect(200)).body;
      expect(state).toMatchObject({ state: 'held', reasons: ['duplicate-revision-content'], review: { status: 'not-reviewable', outstanding: ['resolve-source-conflict'] } });
      expect(state.conflict).toMatchObject({ laboratoryId, revision: 1, resolution: null });
      expect([...state.conflict.revisionIds].sort()).toEqual([a.revisionId, b.revisionId].sort());
      await h.review(s.reviewer, s.report.id, h.accept(a)).expect(409);
    });
    it('resolves by naming one revision: the other stays in history as not selected and is never revived', async () => {
      const { s, second, a, b } = await conflict();
      const series = await seriesOf(s);
      const body = h.resolution(a, b, s, { seriesId: series });
      await h.resolve_(s.uploader, second.report.id, body).expect(409); // the people who saved the evidence cannot choose between it
      const done = await h.resolve_(s.reviewer, second.report.id, body).expect(201);
      expect(done.body).toMatchObject({
        state: 'candidate-for-review',
        review: { status: 'awaiting-review' },
        conflict: { resolution: { outcome: 'use-revision', chosenRevisionId: b.revisionId } },
      });
      expect(done.body.history.map((r: { id: string; selection: string }) => [r.id, r.selection]).sort()).toEqual(
        [
          [a.revisionId, 'not-selected'],
          [b.revisionId, 'selected'],
        ].sort(),
      );
      expect((await h.resolve_(s.reviewer, second.report.id, body).expect(200)).body).toEqual(done.body);
      const old = (await h.record(s.uploader, s.report.id).expect(200)).body;
      expect(old).toMatchObject({ state: 'superseded', reasons: ['not-selected-by-source-resolution'], review: { status: 'not-reviewable' } });
      await h.review(s.reviewer, s.report.id, h.accept(a)).expect(409);
      await h.review(s.reviewer, second.report.id, h.accept(b)).expect(201);
      expect(await lab.count('structured_report_revisions', 'patient_id=$1', [s.patient.id])).toBe(2);
    });
    it.each([
      ['none-usable', 'cannot-establish'],
      ['keep-held', 'awaiting-laboratory'],
    ])('records %s without choosing a source; the series stays held', async (outcome, reasonCode) => {
      const { s, second, a, b } = await conflict();
      const body = h.resolution(a, b, s, { seriesId: await seriesOf(s), outcome, reasonCode, chosenRevisionId: undefined });
      const done = (await h.resolve_(s.reviewer, second.report.id, body).expect(201)).body;
      expect(done).toMatchObject({
        state: 'held',
        review: { status: 'not-reviewable', outstanding: ['await-new-source'] },
        conflict: { resolution: { outcome, chosenRevisionId: null } },
      });
      await h.review(s.reviewer, second.report.id, h.accept(b)).expect(409);
    });
    it('makes a resolution stale when another conflicting source arrives', async () => {
      const { s, second, a, b } = await conflict();
      const body = h.resolution(a, b, s, { seriesId: await seriesOf(s) });
      await h.resolve_(s.reviewer, second.report.id, body).expect(201);
      const third = await h.uploaded(
        Buffer.from(
          JSON.stringify({ ...JSON.parse(bytes().toString()), assessment: null, report: { ...JSON.parse(bytes().toString()).report, limitations: ['Third divergent source.'] } }),
        ),
        s,
      );
      const c = await h.stored(third);
      const state = (await h.record(s.uploader, second.report.id).expect(200)).body;
      expect(state).toMatchObject({ state: 'held', review: { outstanding: ['resolve-source-conflict'] }, conflict: { resolution: null } });
      expect(state.conflict.revisionIds).toHaveLength(3);
      await h.resolve_(s.reviewer, second.report.id, { ...body, requestId: randomUUID() }).expect(409); // names only two of the three
      await h.review(s.reviewer, second.report.id, h.accept(b)).expect(409);
      expect(await lab.count('structured_source_resolutions', 'patient_id=$1', [s.patient.id])).toBe(1);
      expect(c.revisionId).toBeDefined();
    });
    it('refuses a resolution that is not a real conflict, names an unknown revision, or chooses an invalid source', async () => {
      const s = await h.uploaded();
      const a = await h.stored(s);
      const twin = await h.uploaded(bytes(), s); // identical bytes are separate provenance, not a conflict
      const t = await h.stored(twin);
      const series = await seriesOf(s);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, t, s, { seriesId: series })).expect(409);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, a, s, { seriesId: series })).expect(400);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, { revisionId: randomUUID() }, s, { seriesId: series })).expect(409);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, t, s, { seriesId: series, chosenRevisionId: randomUUID() })).expect(400);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, t, s, { seriesId: series, outcome: 'keep-held', reasonCode: 'verified-against-laboratory' })).expect(400);
      expect(await lab.count('structured_source_resolutions', 'patient_id=$1', [s.patient.id])).toBe(0);
    });
    it('refuses a resolution while any source binding is stale', async () => {
      const { s, second, a, b } = await conflict();
      await h.link(s.reviewer, second.report.id, { ...h.confirm(b.p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
      await h.resolve_(s.reviewer, s.report.id, h.resolution(a, b, s, { seriesId: await seriesOf(s) })).expect(409);
    });
  });

  describe('database guards', () => {
    async function rawReview(s: Uploaded) {
      const e = await h.stored(s);
      const id = randomUUID();
      const eventId = randomUUID();
      const sql = `INSERT INTO structured_finding_reviews
        (id,tenant_id,created_by,ledger_event_id,request_id,revision_id,report_id,patient_id,report_sha256,object_version,patient_link_decision_id,source_finding_id,decision,reason_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'syn-finding-a','accepted-as-evidence','matches-source')`;
      const args = (actor = s.reviewer.sub) => [
        id,
        lab.tenant,
        actor,
        eventId,
        randomUUID(),
        e.revisionId,
        s.report.id,
        s.patient.id,
        e.binding.sha256,
        e.binding.objectVersion,
        e.binding.patientLinkDecisionId,
      ];
      return { e, id, eventId, sql, args };
    }
    const withEvent = (raw: Awaited<ReturnType<typeof rawReview>>, actor: string, extra?: () => Promise<void>) =>
      app.get(Database).withTenant(
        lab.tenant,
        async (c) => {
          await c.query(raw.sql, raw.args(actor));
          await extra?.();
          await app.get(LedgerRecordsRepository).appendRecordEvent(c, lab.tenant, 'structured_finding_reviews', raw.id, raw.eventId);
        },
        { actor },
      );
    it('refuses the saver or uploader as reviewer even when the API is bypassed', async () => {
      const s = await h.uploaded();
      const raw = await rawReview(s);
      await expect(withEvent(raw, s.uploader.sub)).rejects.toMatchObject({ code: 'SR004' });
      expect(await lab.count('structured_finding_reviews', 'report_id=$1', [s.report.id])).toBe(0);
    });
    it('rolls back a review without its ledger event, and rechecks the patient link at commit', async () => {
      const s = await h.uploaded();
      const raw = await rawReview(s);
      expect((await attempt(db.appUrl, lab.tenant, s.reviewer.sub, (c) => c.query(raw.sql, raw.args())))?.code).toMatch(/^23/);
      // A different reviewer decides the link inside the open transaction: the same person's admission would wait on this transaction's membership lock.
      const other = await lab.person('reviewer-b', ['reviewer']);
      await expect(
        withEvent(raw, s.reviewer.sub, async () => {
          await h.link(other, s.report.id, { ...h.confirm(raw.e.p), decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
        }),
      ).rejects.toMatchObject({ code: 'SR001' });
      expect(await lab.count('structured_finding_reviews', 'report_id=$1', [s.report.id])).toBe(0);
      expect(await lab.count('ledger_events', 'id=$1', [raw.eventId])).toBe(0);
    });
    it('refuses a revoked reviewer', async () => {
      const s = await h.uploaded();
      const raw = await rawReview(s);
      await withAdmin(db.adminUrl, (c) => c.query("UPDATE tenant_memberships SET status='removed',version=version+1 WHERE tenant_id=$1 AND sub=$2", [lab.tenant, s.reviewer.sub]));
      await expect(withEvent(raw, s.reviewer.sub)).rejects.toMatchObject({ code: '42501' });
      expect(await lab.count('structured_finding_reviews', 'report_id=$1', [s.report.id])).toBe(0);
    });
    it('is append-only, tenant-scoped and covered by the ledger verifier', async () => {
      const s = await h.uploaded();
      const e = await h.stored(s);
      const done = await h.review(s.reviewer, s.report.id, h.accept(e)).expect(201);
      expect(done.body.review.status).toBe('complete');
      const [row] = await lab.row<{ id: string }>('SELECT id FROM structured_finding_reviews WHERE report_id=$1', [s.report.id]);
      for (const sql of [
        'UPDATE structured_finding_reviews SET reason_code=reason_code WHERE id=$1',
        'DELETE FROM structured_finding_reviews WHERE id=$1',
        'TRUNCATE structured_finding_reviews CASCADE',
      ])
        expect(await attempt(db.adminUrl, lab.tenant, s.reviewer.sub, (c) => c.query(sql, sql.includes('$1') ? [row.id] : []))).toMatchObject({ code: '23000' });
      const verifier = LedgerVerifier.connect(db.verifierUrl);
      try {
        expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
        await withAdmin(db.adminUrl, async (c) => {
          await c.query('SET session_replication_role=replica');
          await c.query("UPDATE structured_finding_reviews SET decision='rejected',reason_code='does-not-match-source' WHERE id=$1", [row.id]);
        });
        const verdict = await verifier.verify(lab.tenant);
        expect(verdict.status).toBe('failed');
        expect(verdict.failures).toContainEqual(expect.objectContaining({ kind: 'payload-mismatch' }));
      } finally {
        await verifier.close();
      }
    });
  });
});
