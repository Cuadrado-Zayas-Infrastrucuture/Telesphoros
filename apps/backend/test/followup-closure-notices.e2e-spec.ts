// Spec 045 (audit P0-C): a reminder closed by someone other than its assignee shows to the assignee until they acknowledge it. Real PostgreSQL
// through the application's own role; synthetic people, patients and notes only.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { Database } from '../src/db/database';
import { LedgerVerifier } from '../src/ledger/verifier';

(usingPostgres() ? describe : describe.skip)('follow-up closure notices (spec 045): real PostgreSQL HTTP contract', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, medicationWrites: 'enabled', followupWrites: 'enabled' });
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
  });
  afterAll(async () => {
    await verifier?.close();
    await app?.close();
    await db?.drop();
  });
  const post = (who: Person, patient: string, body: object) => lab.api().post(`/api/v1/patients/${patient}/followups`).set(bearer(who.token)).send(body);
  const get = (who: Person, patient: string) => lab.api().get(`/api/v1/patients/${patient}/followups`).set(bearer(who.token));
  const closures = (who: Person) => lab.api().get('/api/v1/followups/closures').set(bearer(who.token));
  const acknowledge = (who: Person, thread: string, body: object) => lab.api().post(`/api/v1/followups/${thread}/acknowledge`).set(bearer(who.token)).send(body);
  const reminder = (medication: string, assignee: string) => ({
    requestId: randomUUID(),
    action: 'schedule',
    medicationId: medication,
    decisionId: null,
    assessment: null,
    note: 'Synthetic treatment follow-up',
    next: { date: '2026-01-01', timezone: 'America/Puerto_Rico', assignee },
  });
  const dismiss = (medication: string, thread: string, version: number, note = 'Synthetic: covered by a colleague') => ({
    requestId: randomUUID(),
    action: 'dismiss',
    medicationId: medication,
    decisionId: null,
    assessment: null,
    note,
    next: null,
    threadId: thread,
    expectedVersion: version,
  });
  async function world() {
    const clinician = await lab.person('SYN-closure-assignee', ['clinician']);
    const colleague = await lab.person('SYN-closure-colleague', ['clinician']);
    const patient = await lab.patient(clinician);
    await get(colleague, patient).expect(200);
    const medication = (
      await lab
        .api()
        .post(`/api/v1/patients/${patient}/medications`)
        .set(bearer(clinician.token))
        .send({ requestId: randomUUID(), rxcui: BUNDLED_DRUG_LIST!.entries[0]!.rxcui, listVersion: BUNDLED_DRUG_LIST!.version, status: 'active', source: 'patient-reported', startMonth: '2026-01' })
        .expect(201)
    ).body;
    const saved = (await post(clinician, patient, reminder(medication.id, clinician.sub)).expect(201)).body;
    return { clinician, colleague, patient, medication, saved };
  }
  async function closedByColleague() {
    const w = await world();
    const dismissed = (await post(w.colleague, w.patient, dismiss(w.medication.id, w.saved.threadId, 1)).expect(201)).body;
    return { ...w, dismissed };
  }

  it('T-1: a colleague closing the reminder shows to its assignee, with who closed it and the note; not to the colleague', async () => {
    const w = await closedByColleague();
    const mine = (await closures(w.clinician).expect(200)).body;
    expect(mine.total).toBe(1);
    expect(mine.items).toEqual([
      expect.objectContaining({
        followupId: w.dismissed.id,
        threadId: w.saved.threadId,
        patientId: w.patient,
        closedBy: w.colleague.sub,
        note: 'Synthetic: covered by a colleague',
        noteRedacted: false,
      }),
    ]);
    expect(typeof mine.items[0].patientLabel).toBe('string');
    expect(typeof mine.items[0].medicationName).toBe('string');
    expect((await closures(w.colleague).expect(200)).body).toEqual({ items: [], total: 0 });
  });

  it('T-2: the assignee closing their own reminder makes no notice', async () => {
    const w = await world();
    await post(w.clinician, w.patient, dismiss(w.medication.id, w.saved.threadId, 1, 'Synthetic: done')).expect(201);
    expect((await closures(w.clinician).expect(200)).body).toEqual({ items: [], total: 0 });
  });

  it('T-3 and T-4: acknowledging removes the notice, writes one ledger event, replays by request id, and refuses a second', async () => {
    const w = await closedByColleague();
    const requestId = randomUUID();
    const acked = (await acknowledge(w.clinician, w.saved.threadId, { requestId, followupId: w.dismissed.id }).expect(201)).body;
    expect(acked).toMatchObject({ followupId: w.dismissed.id, threadId: w.saved.threadId });
    expect((await closures(w.clinician).expect(200)).body).toEqual({ items: [], total: 0 });
    expect(await lab.count('patient_followup_closure_acks', 'followup_id=$1', [w.dismissed.id])).toBe(1);
    expect(await lab.count('ledger_events', "tenant_id=$1 AND event_type='patient-followup-closure-ack' AND subject_id=$2", [lab.tenant, acked.id])).toBe(1);
    const replay = (await acknowledge(w.clinician, w.saved.threadId, { requestId, followupId: w.dismissed.id }).expect(201)).body;
    expect(replay.id).toBe(acked.id);
    const again = await acknowledge(w.clinician, w.saved.threadId, { requestId: randomUUID(), followupId: w.dismissed.id }).expect(409);
    expect(again.body.error.details[0].reason).toBe('already-acknowledged');
    expect(await lab.count('patient_followup_closure_acks', 'followup_id=$1', [w.dismissed.id])).toBe(1);
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });

  it('T-5: only the assignee may acknowledge, only a dismiss by someone else, only in their organization', async () => {
    const w = await closedByColleague();
    // The closer is not the assignee.
    await acknowledge(w.colleague, w.saved.threadId, { requestId: randomUUID(), followupId: w.dismissed.id }).expect(403);
    // Not a dismiss: the scheduling version.
    await acknowledge(w.clinician, w.saved.threadId, { requestId: randomUUID(), followupId: w.saved.id }).expect(400);
    // A follow-up id that is not of this thread.
    await acknowledge(w.clinician, randomUUID(), { requestId: randomUUID(), followupId: w.dismissed.id }).expect(400);
    // The assignee's own dismiss.
    const own = await world();
    const ownDismiss = (await post(own.clinician, own.patient, dismiss(own.medication.id, own.saved.threadId, 1, 'Synthetic: done')).expect(201)).body;
    await acknowledge(own.clinician, own.saved.threadId, { requestId: randomUUID(), followupId: ownDismiss.id }).expect(400);
    // Another organization cannot see it.
    const other = new LabPipeline(app, db.adminUrl);
    const outsider = await other.person('SYN-closure-outsider', ['clinician']);
    await other.patient(outsider);
    await other.api().post(`/api/v1/followups/${w.saved.threadId}/acknowledge`).set(bearer(outsider.token)).send({ requestId: randomUUID(), followupId: w.dismissed.id }).expect(404);
    // A reviewer reads (nothing of theirs) but cannot acknowledge.
    const reviewer = await lab.person('SYN-closure-reviewer', ['reviewer']);
    expect((await closures(reviewer).expect(200)).body).toEqual({ items: [], total: 0 });
    await acknowledge(reviewer, w.saved.threadId, { requestId: randomUUID(), followupId: w.dismissed.id }).expect(403);
    expect(await lab.count('patient_followup_closure_acks', 'followup_id=$1', [w.dismissed.id])).toBe(0);
    expect((await closures(w.clinician).expect(200)).body.total).toBe(1);
  });

  it('T-5: the database itself refuses a direct insert by someone else and any change, through the application role', async () => {
    const w = await closedByColleague();
    const connection = app.get(Database);
    const row = (actor: string) =>
      connection.withTenant(
        lab.tenant,
        (client) =>
          client.query(
            `INSERT INTO patient_followup_closure_acks (id,tenant_id,created_by,ledger_event_id,followup_id,thread_id,patient_id,creation_request_id,creation_request_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), lab.tenant, actor, randomUUID(), w.dismissed.id, w.saved.threadId, w.patient, randomUUID(), 'a'.repeat(64)],
          ),
        { actor },
      );
    await expect(row(w.colleague.sub)).rejects.toMatchObject({ code: '42501' });
    const reviewer = await lab.person('SYN-closure-direct-reviewer', ['reviewer']);
    await expect(row(reviewer.sub)).rejects.toMatchObject({ code: '42501' });
    const acked = (await acknowledge(w.clinician, w.saved.threadId, { requestId: randomUUID(), followupId: w.dismissed.id }).expect(201)).body;
    for (const sql of ['UPDATE patient_followup_closure_acks SET thread_id=thread_id WHERE id=$1', 'DELETE FROM patient_followup_closure_acks WHERE id=$1']) {
      await expect(connection.withTenant(lab.tenant, (client) => client.query(sql, [acked.id]), { actor: w.clinician.sub })).rejects.toMatchObject({ code: '42501' });
    }
    const other = new LabPipeline(app, db.adminUrl);
    const outsider = await other.person('SYN-closure-direct-outsider', ['clinician']);
    const invisible = await connection.withTenant(other.tenant, (client) => client.query('SELECT id FROM patient_followup_closure_acks WHERE id=$1', [acked.id]));
    expect(invisible.rows).toEqual([]);
    void outsider;
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });

  it('T-6: with follow-up writes paused, acknowledging is refused and notices stay readable', async () => {
    const w = await closedByColleague();
    const paused = await createTestApp({ postgresUrl: db.appUrl });
    try {
      const requests = new LabPipeline(paused, db.adminUrl).api();
      const refused = await requests
        .post(`/api/v1/followups/${w.saved.threadId}/acknowledge`)
        .set(bearer(w.clinician.token))
        .send({ requestId: randomUUID(), followupId: w.dismissed.id })
        .expect(503);
      expect(refused.body.error.details[0].reason).toBe('followup-writes-paused');
      expect((await requests.get('/api/v1/followups/closures').set(bearer(w.clinician.token)).expect(200)).body.total).toBe(1);
    } finally {
      await paused.close();
    }
  });

  it('refuses a malformed acknowledgement', async () => {
    const w = await closedByColleague();
    for (const body of [{}, { requestId: randomUUID() }, { followupId: w.dismissed.id }, { requestId: 'x', followupId: w.dismissed.id }, { requestId: randomUUID(), followupId: w.dismissed.id, extra: 1 }]) {
      await acknowledge(w.clinician, w.saved.threadId, body).expect(400);
    }
  });
});
