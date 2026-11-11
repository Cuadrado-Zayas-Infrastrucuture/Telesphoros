import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { Database } from '../src/db/database';
import { ENV, type Env } from '../src/config/env';
import { LedgerVerifier } from '../src/ledger/verifier';

(usingPostgres() ? describe : describe.skip)('treatment follow-ups: real PostgreSQL HTTP contract', () => {
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
  const get = (who: Person, patient: string, query = '') => lab.api().get(`/api/v1/patients/${patient}/followups${query}`).set(bearer(who.token));
  async function world() {
    const clinician = await lab.person('SYN-followup-clinician', ['clinician']);
    const patient = await lab.patient(clinician);
    const medication = (
      await lab
        .api()
        .post(`/api/v1/patients/${patient}/medications`)
        .set(bearer(clinician.token))
        .send({
          requestId: randomUUID(),
          rxcui: BUNDLED_DRUG_LIST!.entries[0]!.rxcui,
          listVersion: BUNDLED_DRUG_LIST!.version,
          status: 'active',
          source: 'patient-reported',
          startMonth: '2026-01',
        })
        .expect(201)
    ).body;
    return { clinician, patient, medication };
  }
  const scheduled = (medication: string, assignee: string) => ({
    requestId: randomUUID(),
    action: 'schedule',
    medicationId: medication,
    decisionId: null,
    assessment: null,
    note: 'Synthetic treatment follow-up',
    next: { date: '2026-01-01', timezone: 'America/Puerto_Rico', assignee },
  });
  const summary = (who: Person, query = '') => lab.api().get(`/api/v1/followups/summary${query}`).set(bearer(who.token));
  const inbox = (who: Person, query = '') => lab.api().get(`/api/v1/followups${query}`).set(bearer(who.token));
  it('filters assigned reminders before pagination while keeping clinic counts complete', async () => {
    const { clinician, patient, medication } = await world();
    const colleague = await lab.person('SYN-filter-colleague', ['clinician']);
    await get(colleague, patient).expect(200);
    for (let index = 0; index < 21; index++) await post(clinician, patient, scheduled(medication.id, colleague.sub)).expect(201);
    const input = scheduled(medication.id, clinician.sub);
    const mine = (await post(clinician, patient, { ...input, next: { ...input.next, date: '2099-01-01' } }).expect(201)).body;
    const selected = (await inbox(clinician, '?assignment=mine&status=upcoming').expect(200)).body;
    expect(selected.items.map((item: { id: string }) => item.id)).toEqual([mine.id]);
    expect(selected).toMatchObject({ page: 1, hasMore: false, counts: { overdue: 21, today: 0, upcoming: 1, unassigned: 0 } });
    const first = (await inbox(colleague, '?assignment=mine&status=overdue').expect(200)).body;
    const second = (await inbox(colleague, '?assignment=mine&status=overdue&page=2').expect(200)).body;
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size).toBe(21);
    expect((await inbox(clinician, '?assignment=mine&status=overdue').expect(200)).body.items).toEqual([]);
  });
  it('filters only the current reminder and updates assignment and status after rescheduling or closing', async () => {
    const { clinician, patient, medication } = await world();
    const colleague = await lab.person('SYN-filter-reassigned', ['clinician']);
    await get(colleague, patient).expect(200);
    const input = scheduled(medication.id, clinician.sub);
    const saved = (await post(clinician, patient, input).expect(201)).body;
    await post(clinician, patient, {
      ...input,
      requestId: randomUUID(),
      threadId: saved.threadId,
      expectedVersion: 1,
      action: 'reschedule',
      next: { ...input.next, date: '2099-01-01', assignee: colleague.sub },
    }).expect(201);
    expect((await inbox(clinician, '?assignment=mine').expect(200)).body.items).toEqual([]);
    expect((await inbox(clinician, '?status=overdue').expect(200)).body.items).toEqual([]);
    expect((await inbox(colleague, '?assignment=mine&status=upcoming').expect(200)).body.items).toEqual([expect.objectContaining({ threadId: saved.threadId, version: 2 })]);
    await post(clinician, patient, { ...input, requestId: randomUUID(), threadId: saved.threadId, expectedVersion: 2, action: 'dismiss', next: null }).expect(201);
    expect((await inbox(colleague, '?assignment=mine&status=upcoming').expect(200)).body.items).toEqual([]);
  });
  it('selects due-today by the recorded timezone and keeps removed assignees discoverable', async () => {
    const { clinician, patient, medication } = await world();
    const colleague = await lab.person('SYN-filter-removed', ['clinician']);
    await get(colleague, patient).expect(200);
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const today = await withAdmin(db.adminUrl, (client) => client.query('SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS date', [zone]));
      const input = scheduled(medication.id, colleague.sub);
      await post(clinician, patient, { ...input, next: { ...input.next, date: today.rows[0].date, timezone: zone } }).expect(201);
    }
    const due = (await inbox(clinician, '?status=today').expect(200)).body;
    expect(due.items).toHaveLength(2);
    expect(due.items.every((item: { dueState: string }) => item.dueState === 'today')).toBe(true);
    await withAdmin(db.adminUrl, (client) =>
      client.query("UPDATE tenant_memberships SET status='removed',version=version+1 WHERE tenant_id=$1 AND sub=$2", [lab.tenant, colleague.sub]),
    );
    const unassigned = (await inbox(clinician, '?status=reassignment').expect(200)).body;
    expect(unassigned.items).toHaveLength(2);
    expect(unassigned.items.every((item: { needsReassignment: boolean }) => item.needsReassignment)).toBe(true);
    expect(unassigned.counts.unassigned).toBe(2);
    expect((await inbox(clinician, '?assignment=mine&status=reassignment').expect(200)).body.items).toEqual([]);
  });
  it('keeps inbox filters tenant and role scoped and rejects malformed or history-mixed selectors', async () => {
    const { clinician, patient, medication } = await world();
    const saved = (await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201)).body;
    const outsider = await new LabPipeline(app, db.adminUrl).person('SYN-filter-outsider', ['clinician']);
    expect((await inbox(outsider, '?assignment=all&status=overdue').expect(200)).body.items).toEqual([]);
    const reviewer = await lab.person('SYN-filter-reviewer', ['reviewer']);
    expect((await inbox(reviewer, '?status=overdue').expect(200)).body.items).toHaveLength(1);
    expect((await inbox(reviewer, '?assignment=mine').expect(200)).body.items).toEqual([]);
    for (const role of ['reader', 'admin'] as const) await inbox(await lab.person(`SYN-filter-${role}`, [role]), '?assignment=mine').expect(403);
    await lab.api().get('/api/v1/followups?assignment=mine').expect(401);
    for (const query of [
      '?assignment=other',
      '?status=closed',
      '?assignment=mine&assignment=all',
      '?status=today&status=overdue',
      '?tenantId=other',
      `?assignee=${clinician.sub}`,
      `?threadId=${saved.threadId}&assignment=mine`,
    ])
      await inbox(clinician, query).expect(400);
    await get(clinician, patient, '?assignment=mine').expect(400);
  });
  const assessment = (response: string) => ({
    date: '2025-12-01',
    timezone: 'America/Puerto_Rico',
    response,
    symptoms: 'not-assessed',
    adherence: 'not-assessed',
    source: 'clinician-assessed',
  });
  it('summarizes every response category and missing assessments without duplicate retries or record details', async () => {
    const { clinician, patient, medication } = await world();
    for (const response of ['improved', 'unchanged', 'worsened', 'not-assessed']) {
      const input = { ...scheduled(medication.id, clinician.sub), action: 'document', assessment: assessment(response), next: null };
      await post(clinician, patient, input).expect(201);
      await post(clinician, patient, input).expect(201);
    }
    await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201);
    const result = (await summary(clinician).expect(200)).body;
    expect(result).toEqual({
      definition: 'followup-response-v1',
      asOf: expect.any(String),
      total: 5,
      responses: { improved: 1, unchanged: 1, worsened: 1, notAssessed: 1, noAssessment: 1 },
    });
    expect(Number.isNaN(Date.parse(result.asOf))).toBe(false);
  });
  it('summarizes the corrected latest assessment even after rescheduling and closing its reminder', async () => {
    const { clinician, patient, medication } = await world();
    const input = { ...scheduled(medication.id, clinician.sub), action: 'document', assessment: assessment('improved') };
    const first = (await post(clinician, patient, input).expect(201)).body;
    await post(clinician, patient, {
      ...input,
      requestId: randomUUID(),
      threadId: first.threadId,
      expectedVersion: 1,
      action: 'amend',
      assessment: assessment('unchanged'),
    }).expect(201);
    const change = { ...scheduled(medication.id, clinician.sub), threadId: first.threadId, expectedVersion: 2, action: 'reschedule' };
    await post(clinician, patient, change).expect(201);
    await post(clinician, patient, { ...change, requestId: randomUUID(), expectedVersion: 3, action: 'dismiss', next: null }).expect(201);
    expect((await summary(clinician).expect(200)).body).toMatchObject({ total: 1, responses: { improved: 0, unchanged: 1, worsened: 0, notAssessed: 0, noAssessment: 0 } });
  });
  it('summarizes beyond list pagination and excludes deleted patients', async () => {
    const { clinician, patient, medication } = await world();
    for (let index = 0; index < 21; index++) await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201);
    expect((await get(clinician, patient).expect(200)).body.items).toHaveLength(20);
    expect((await summary(clinician).expect(200)).body).toMatchObject({ total: 21, responses: { noAssessment: 21 } });
    await lab.api().delete(`/api/v1/patients/${patient}`).set(bearer(clinician.token)).expect(204);
    expect((await summary(clinician).expect(200)).body).toMatchObject({ total: 0, responses: { improved: 0, unchanged: 0, worsened: 0, notAssessed: 0, noAssessment: 0 } });
  });
  it('scopes the summary to the clinic and clinical read roles and refuses unsupported filters', async () => {
    const { clinician, patient, medication } = await world();
    await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201);
    const other = new LabPipeline(app, db.adminUrl);
    const outsider = await other.person('SYN-summary-other', ['clinician']);
    expect((await summary(outsider).expect(200)).body.total).toBe(0);
    const reviewer = await lab.person('SYN-summary-reviewer', ['reviewer']);
    expect((await summary(reviewer).expect(200)).body.total).toBe(1);
    for (const role of ['reader', 'admin'] as const) {
      const person = await lab.person(`SYN-summary-${role}`, [role]);
      await summary(person).expect(403);
    }
    await lab.api().get('/api/v1/followups/summary').expect(401);
    await summary(clinician, '?tenantId=other').expect(400);
    await summary(clinician, '?page=2').expect(400);
  });
  it('uses the reminder timezone at local midnight and across a daylight-saving change', async () => {
    for (const [date, zone, at, expected] of [
      ['2026-01-02', 'America/Puerto_Rico', '2026-01-02T03:59:59Z', 'upcoming'],
      ['2026-01-02', 'America/Puerto_Rico', '2026-01-02T04:00:00Z', 'today'],
      ['2026-01-02', 'America/Puerto_Rico', '2026-01-03T04:00:00Z', 'overdue'],
      ['2026-03-08', 'America/New_York', '2026-03-09T03:59:59Z', 'today'],
      ['2026-03-08', 'America/New_York', '2026-03-09T04:00:00Z', 'overdue'],
    ]) {
      const result = await withAdmin(db.adminUrl, (client) => client.query('SELECT patient_followups_due_state($1,$2,$3) AS state', [date, zone, at]));
      expect(result.rows).toEqual([{ state: expected }]);
    }
  });
  it('saves documentation and the next reminder together, survives reload and verifies its ledger', async () => {
    const { clinician, patient, medication } = await world();
    const payload = {
      requestId: randomUUID(),
      action: 'document',
      medicationId: medication.id,
      decisionId: null,
      assessment: { date: '2026-01-20', timezone: 'America/Puerto_Rico', response: 'improved', symptoms: 'not-assessed', adherence: 'not-assessed', source: 'patient-reported' },
      note: 'Synthetic patient reports improvement; adverse symptoms not assessed.',
      next: { date: '2026-02-03', timezone: 'America/Puerto_Rico', assignee: clinician.sub },
    };
    const saved = (await post(clinician, patient, payload).expect(201)).body;
    expect(saved).toMatchObject({ version: 1, action: 'document', assessment: payload.assessment, next: payload.next });
    const reloaded = (await get(clinician, patient).expect(200)).body;
    expect(reloaded.items).toEqual([expect.objectContaining({ id: saved.id, note: payload.note, dueState: 'overdue' })]);
    expect((await post(clinician, patient, payload).expect(201)).body.id).toBe(saved.id);
    await post(clinician, patient, { ...payload, note: 'Different synthetic note' }).expect(409);
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });
  it('retains original deadlines through rescheduling, rejects stale edits and closes only on explicit dismissal', async () => {
    const { clinician, patient, medication } = await world();
    const payload = scheduled(medication.id, clinician.sub);
    const first = (await post(clinician, patient, payload).expect(201)).body;
    await get(clinician, patient).expect(200);
    const reschedule = {
      ...payload,
      requestId: randomUUID(),
      threadId: first.threadId,
      expectedVersion: 1,
      action: 'reschedule',
      note: 'Synthetic visit moved',
      next: { ...payload.next, date: '2099-01-01' },
    };
    const next = (await post(clinician, patient, reschedule).expect(201)).body;
    expect(next).toMatchObject({ version: 2, dueState: 'upcoming' });
    await post(clinician, patient, { ...reschedule, requestId: randomUUID() }).expect(409);
    const history = (await get(clinician, patient, `?threadId=${first.threadId}`).expect(200)).body.items;
    expect(history.map((entry: { next: { date: string } }) => entry.next.date).sort()).toEqual(['2026-01-01', '2099-01-01']);
    await post(clinician, patient, {
      ...reschedule,
      requestId: randomUUID(),
      expectedVersion: 2,
      action: 'dismiss',
      next: null,
      note: 'Synthetic follow-up no longer needed',
    }).expect(201);
    const current = (await get(clinician, patient).expect(200)).body;
    expect(current.items[0]).toMatchObject({ version: 3, dueState: 'closed' });
    expect(current.counts).toEqual({ overdue: 0, today: 0, upcoming: 0, unassigned: 0 });
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });
  it('allows one winner for concurrent edits and replays concurrent identical requests once', async () => {
    const { clinician, patient, medication } = await world();
    const payload = scheduled(medication.id, clinician.sub);
    const replies = await Promise.all([post(clinician, patient, payload), post(clinician, patient, payload)]);
    expect(replies.map((reply) => reply.status)).toEqual([201, 201]);
    expect(replies[0]!.body.id).toBe(replies[1]!.body.id);
    const change = { ...payload, threadId: replies[0]!.body.threadId, expectedVersion: 1, action: 'reschedule' };
    const edits = await Promise.all([post(clinician, patient, { ...change, requestId: randomUUID() }), post(clinician, patient, { ...change, requestId: randomUUID() })]);
    expect(edits.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(await lab.count('patient_followups', 'patient_id=$1', [patient])).toBe(2);
  });
  it('refuses other-patient medication, other-tenant access, readers, and inactive assignees without partial records', async () => {
    const { clinician, patient, medication } = await world();
    const another = await lab.patient(clinician);
    const reader = await lab.person('SYN-followup-reader', ['reader']);
    const reviewer = await lab.person('SYN-followup-reviewer', ['reviewer']);
    const outsider = await new LabPipeline(app, db.adminUrl).person('SYN-followup-outsider', ['clinician']);
    const payload = scheduled(medication.id, clinician.sub);
    await post(clinician, another, payload).expect(400);
    await post(outsider, patient, payload).expect(404);
    await get(outsider, patient).expect(404);
    await post(reader, patient, payload).expect(403);
    await get(reader, patient).expect(403);
    await post(reviewer, patient, payload).expect(403);
    await get(reviewer, patient).expect(200);
    await post(clinician, patient, { ...payload, next: { ...payload.next, assignee: reviewer.sub } }).expect(400);
    expect(await lab.count('patient_followups', 'patient_id=$1', [patient])).toBe(0);
    expect(await lab.count('event_notes', 'tenant_id=$1', [lab.tenant])).toBe(0);
    await post(clinician, patient, payload).expect(201);
  });
  it('keeps a removed assignee visible as needing reassignment', async () => {
    const { clinician, patient, medication } = await world();
    const assignee = await lab.person('SYN-followup-assignee', ['clinician']);
    await get(assignee, patient).expect(200); // The test identity provider admits membership on the first authenticated request.
    const payload = scheduled(medication.id, assignee.sub);
    const saved = (await post(clinician, patient, payload).expect(201)).body;
    await withAdmin(db.adminUrl, async (client) => {
      await client.query("UPDATE tenant_memberships SET status='removed',version=version+1 WHERE tenant_id=$1 AND sub=$2", [lab.tenant, assignee.sub]);
    });
    const current = (await get(clinician, patient).expect(200)).body;
    expect(current.items[0]).toMatchObject({ needsReassignment: true, dueState: 'overdue' });
    expect(current.counts.unassigned).toBe(1);
    const changed = (
      await post(clinician, patient, {
        ...payload,
        requestId: randomUUID(),
        action: 'reschedule',
        threadId: saved.threadId,
        expectedVersion: 1,
        next: { ...payload.next, assignee: clinician.sub },
      }).expect(201)
    ).body;
    expect(changed.needsReassignment).toBe(false);
  });
  it('amends only the latest assessment by its author and keeps its reminder unchanged', async () => {
    const { clinician, patient, medication } = await world();
    const other = await lab.person('SYN-followup-colleague', ['clinician']);
    const payload = {
      ...scheduled(medication.id, clinician.sub),
      action: 'document',
      next: null,
      assessment: {
        date: '2025-12-01',
        timezone: 'Pacific/Kiritimati',
        response: 'not-assessed',
        symptoms: 'not-assessed',
        adherence: 'not-assessed',
        source: 'clinician-assessed',
      },
    };
    const saved = (await post(clinician, patient, payload).expect(201)).body;
    const amendment = { ...payload, requestId: randomUUID(), action: 'amend', threadId: saved.threadId, expectedVersion: 1, note: 'Corrected synthetic documentation' };
    await post(other, patient, amendment).expect(400);
    await post(clinician, patient, { ...amendment, next: scheduled(medication.id, clinician.sub).next }).expect(400);
    const corrected = (await post(clinician, patient, amendment).expect(201)).body;
    expect(corrected).toMatchObject({ version: 2, next: null, note: amendment.note });
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });
  it('keeps persisted records readable while writes are paused, including in production', async () => {
    const { clinician, patient, medication } = await world();
    const payload = scheduled(medication.id, clinician.sub);
    await post(clinician, patient, payload).expect(201);
    const paused = await createTestApp({ postgresUrl: db.appUrl });
    try {
      const requests = new LabPipeline(paused, db.adminUrl).api();
      const refused = await requests
        .post(`/api/v1/patients/${patient}/followups`)
        .set(bearer(clinician.token))
        .send({ ...payload, requestId: randomUUID() })
        .expect(503);
      expect(refused.body.error.details[0].reason).toBe('followup-writes-paused');
      await requests.get(`/api/v1/patients/${patient}/followups`).set(bearer(clinician.token)).expect(200);
      // The availability read reports the same rule the write enforces, in both paused shapes.
      const availability = () => requests.get('/api/v1/followups/availability').set(bearer(clinician.token)).expect(200);
      expect((await availability()).body).toEqual({ recording: 'paused' });
      const env = paused.get<Env>(ENV);
      env.FOLLOWUP_WRITES = 'enabled';
      expect((await availability()).body).toEqual({ recording: 'enabled' });
      env.NODE_ENV = 'production';
      expect((await availability()).body).toEqual({ recording: 'paused' });
      await requests
        .post(`/api/v1/patients/${patient}/followups`)
        .set(bearer(clinician.token))
        .send({ ...payload, requestId: randomUUID() })
        .expect(503);
      expect(await lab.count('patient_followups', 'patient_id=$1', [patient])).toBe(1);
    } finally {
      await paused.close();
    }
  });
  it('counts reminders beyond the first page and excludes closed tasks from the clinic inbox', async () => {
    const { clinician, patient, medication } = await world();
    for (let index = 0; index < 21; index++) await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201);
    const first = (await get(clinician, patient).expect(200)).body;
    const second = (await get(clinician, patient, '?page=2').expect(200)).body;
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(1);
    expect(first.counts.overdue).toBe(21);
    expect(second.counts.overdue).toBe(21);
    expect(new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size).toBe(21);
    const saved = first.items[0];
    await post(clinician, patient, { ...scheduled(medication.id, clinician.sub), action: 'dismiss', threadId: saved.threadId, expectedVersion: 1, next: null }).expect(201);
    const inbox = (await lab.api().get('/api/v1/followups').set(bearer(clinician.token)).expect(200)).body;
    expect(inbox.items).toHaveLength(20);
    expect(inbox.hasMore).toBe(false);
    expect(inbox.counts.overdue).toBe(20);
    expect(inbox.items.every((item: { next: unknown }) => item.next !== null)).toBe(true);
  });
  it('enforces tenant reads and append-only history through the real application database role', async () => {
    const { clinician, patient, medication } = await world();
    const saved = (await post(clinician, patient, scheduled(medication.id, clinician.sub)).expect(201)).body;
    const connection = app.get(Database);
    const other = new LabPipeline(app, db.adminUrl);
    const outsider = await other.person('SYN-direct-other', ['clinician']);
    await other.patient(outsider);
    const invisible = await connection.withTenant(other.tenant, (client) => client.query('SELECT id FROM patient_followups WHERE id=$1', [saved.id]));
    expect(invisible.rows).toEqual([]);
    for (const sql of ['UPDATE patient_followups SET version=99 WHERE id=$1', 'DELETE FROM patient_followups WHERE id=$1']) {
      await expect(connection.withTenant(lab.tenant, (client) => client.query(sql, [saved.id]), { actor: clinician.sub })).rejects.toMatchObject({ code: '42501' });
    }
    expect((await get(clinician, patient).expect(200)).body.items[0].version).toBe(1);
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });
  it('refuses malformed or implicit assessment/reminder choices', async () => {
    const { clinician, patient, medication } = await world();
    const payload = scheduled(medication.id, clinician.sub);
    for (const changed of [
      { next: null },
      { note: '' },
      { next: { ...payload.next, date: '2026-02-30' } },
      { next: { ...payload.next, timezone: 'Unknown/Synthetic' } },
      { action: 'document' },
      { assessment: { date: '2025-01-01' } },
    ]) {
      await post(clinician, patient, { ...payload, ...changed }).expect(400);
    }
    await post(clinician, patient, payload).expect(201);
  });
});
