import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { drugListSchema, patientMedicationDtoSchema, patientMedicationsDtoSchema } from '@telesphoros/shared-types';
import { Logger } from 'nestjs-pino';
import { MEDICATION_DRUG_LIST } from '../src/patient-medications/patient-medications.service';
import { pinoHttpOptions } from '../src/logger-options';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
// Invented source fixture, injected ONLY in this test; not shipped as a drug list.
const NAME = 'syn-medication-zzyzx';
const LIST = drugListSchema.parse({
  status: 'verified',
  version: 'a'.repeat(64),
  cpicRelease: 'synthetic-fixture',
  cpicSource: 'https://example.invalid',
  accessedAt: '2026-11-01T00:00:00.000Z',
  rxnormRelease: 'synthetic-fixture',
  attribution: 'synthetic',
  currencyNotice: 'synthetic',
  citations: ['synthetic1', 'synthetic2', 'synthetic3'],
  sourceProperties: [
    { rxcui: '991001', name: NAME, tty: 'IN' },
    { rxcui: '991002', name: 'hydroxyzine', tty: 'IN' },
  ],
  entries: [
    { rxcui: '991001', name: NAME, displayName: NAME, tty: 'IN', rxnormRelease: 'synthetic-fixture' },
    { rxcui: '991002', name: 'hydroxyzine', displayName: 'hydrOXYzine', tty: 'IN', rxnormRelease: 'synthetic-fixture' },
  ],
});
const body = (over: object = {}) => ({
  requestId: randomUUID(),
  rxcui: '991001',
  listVersion: LIST.version,
  status: 'active',
  startMonth: '2026-01',
  stopMonth: null,
  source: 'patient-reported',
  ...over,
});
(usingPostgres() ? describe : describe.skip)('patient medications: real PostgreSQL HTTP contract', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  const logged: string[] = [];
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logged.push(chunk.toString());
        done();
      },
    });
    app = await createTestApp({
      postgresUrl: db.appUrl,
      medicationWrites: 'enabled',
      overrides: [
        { provide: MEDICATION_DRUG_LIST, useValue: LIST },
        { provide: 'pino-params', useValue: { pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'trace' }), sink] } },
      ],
    });
    app.useLogger(app.get(Logger));
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
  const post = (who: Person, patient: string, payload: object) => lab.api().post(`/api/v1/patients/${patient}/medications`).set(bearer(who.token)).send(payload);
  const get = (who: Person, patient: string, query = '') => lab.api().get(`/api/v1/patients/${patient}/medications${query}`).set(bearer(who.token));
  async function world() {
    const clinician = await lab.person('SYN-clinician', ['clinician']);
    return { clinician, patient: await lab.patient(clinician) };
  }
  it('adds independent entries, appends stop/correction versions, reads history and verifies all events', async () => {
    const { clinician, patient } = await world();
    expect((await get(clinician, patient).expect(200)).body).toEqual({ items: [] });
    const first = (await post(clinician, patient, body()).expect(201)).body;
    expect(patientMedicationDtoSchema.safeParse(first).success).toBe(true);
    const second = (await post(clinician, patient, body()).expect(201)).body;
    const stopped = (await post(clinician, patient, body({ entryId: first.entryId, expectedVersion: 1, status: 'stopped', stopMonth: '2026-03' })).expect(201)).body;
    expect(stopped).toMatchObject({ entryId: first.entryId, version: 2, current: true, name: NAME, status: 'stopped' });
    const latest = (await get(clinician, patient).expect(200)).body;
    expect(patientMedicationsDtoSchema.safeParse(latest).success).toBe(true);
    expect(latest.items.map((x: { entryId: string }) => x.entryId)).toEqual([second.entryId, first.entryId]);
    const historic = (await get(clinician, patient, `?entryId=${first.entryId}&version=1`).expect(200)).body.items[0];
    expect(historic).toMatchObject({ version: 1, current: false, status: 'active', name: NAME });
    expect(await lab.count('patient_medications', 'patient_id=$1', [patient])).toBe(3);
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', eventsChecked: 3, failures: [] });
  });
  async function afterRetirement(run: (updated: LabPipeline) => Promise<void>) {
    const updatedApp = await createTestApp({
      postgresUrl: db.appUrl,
      medicationWrites: 'enabled',
      overrides: [{ provide: MEDICATION_DRUG_LIST, useValue: { ...LIST, version: 'b'.repeat(64), entries: [LIST.entries[1]] } }],
    });
    try {
      await run(new LabPipeline(updatedApp, db.adminUrl, lab.tenant));
    } finally {
      await updatedApp.close();
    }
  }
  it.each(['stop', 'correct'] as const)('can %s an existing ingredient after retirement without rewriting its provenance', async (action) => {
    const { clinician, patient } = await world();
    const first = (await post(clinician, patient, body()).expect(201)).body;
    await afterRetirement(async (updated) => {
      const payload = body({
        entryId: first.entryId,
        expectedVersion: 1,
        listVersion: 'b'.repeat(64),
        ...(action === 'stop' ? { status: 'stopped', stopMonth: '2026-03' } : { source: 'clinician-entered', startMonth: '2025-12' }),
      });
      const save = (data: object) => updated.api().post(`/api/v1/patients/${patient}/medications`).set(bearer(clinician.token)).send(data);
      const results = await Promise.all(Array.from({ length: 4 }, () => save(payload)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results[0]!.body).toMatchObject({
        entryId: first.entryId,
        version: 2,
        rxcui: '991001',
        name: NAME,
        listVersion: LIST.version,
        ...(action === 'stop' ? { status: 'stopped', stopMonth: '2026-03' } : { source: 'clinician-entered', startMonth: '2025-12' }),
      });
      await save({ ...payload, requestId: randomUUID() }).expect(409);
      await save({ ...payload, source: 'patient-reported', startMonth: '2025-11' }).expect(409);
      const historic = (await get(clinician, patient, `?entryId=${first.entryId}&version=1`).expect(200)).body.items[0];
      expect(historic).toMatchObject({ name: NAME, listVersion: LIST.version, version: 1, current: false, status: 'active', startMonth: '2026-01' });
      expect(await lab.count('patient_medications', 'patient_id=$1', [patient])).toBe(2);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', eventsChecked: 2, failures: [] });
    });
  });
  it('does not admit retired codes as new entries, replacements or cross-patient/tenant edits', async () => {
    const { clinician, patient } = await world();
    const first = (await post(clinician, patient, body()).expect(201)).body;
    const other = (await post(clinician, patient, body({ rxcui: '991002' })).expect(201)).body;
    const otherPatient = await lab.patient(clinician);
    const outsider = await new LabPipeline(app, db.adminUrl).person('SYN-outsider', ['clinician']);
    const reader = await lab.person('SYN-reader', ['reader']);
    await afterRetirement(async (updated) => {
      const save = (who: Person, target: string, data: object) => updated.api().post(`/api/v1/patients/${target}/medications`).set(bearer(who.token)).send(data);
      const edit = body({ listVersion: 'b'.repeat(64), entryId: first.entryId, expectedVersion: 1 });
      await save(clinician, patient, body({ listVersion: 'b'.repeat(64) })).expect(400);
      await save(clinician, patient, { ...edit, entryId: other.entryId }).expect(400);
      await save(clinician, otherPatient, edit).expect(400);
      await save(outsider, patient, edit).expect(404);
      await save(reader, patient, edit).expect(403);
      await save(clinician, patient, { ...edit, listVersion: LIST.version }).expect(409);
      await save(clinician, patient, { ...edit, rxcui: '991003' }).expect(400);
      expect(await lab.count('patient_medications', 'patient_id=$1', [patient])).toBe(2);
    });
  });
  it('fences every medication POST by default without consuming a retry id, while authorized history stays readable', async () => {
    const { clinician, patient } = await world();
    const original = body();
    const first = (await post(clinician, patient, original).expect(201)).body;
    const reader = await lab.person('SYN-reader', ['reader']);
    const outsider = await new LabPipeline(app, db.adminUrl).person('SYN-outsider', ['clinician']);
    const fencedApp = await createTestApp({ postgresUrl: db.appUrl, overrides: [{ provide: MEDICATION_DRUG_LIST, useValue: LIST }] });
    const fenced = new LabPipeline(fencedApp, db.adminUrl, lab.tenant);
    const save = (who: Person, target: string, data: object) => fenced.api().post(`/api/v1/patients/${target}/medications`).set(bearer(who.token)).send(data);
    const correction = body({ entryId: first.entryId, expectedVersion: 1, source: 'clinician-entered' });
    try {
      for (const input of [body(), correction, body({ entryId: first.entryId, expectedVersion: 1, status: 'stopped' }), original]) {
        const response = await save(clinician, patient, input).expect(503);
        expect(response.body.error.details).toEqual([
          { field: 'request', reason: 'medication-writes-fenced', message: 'Medication recording is temporarily paused. Retry later.' },
        ]);
      }
      await save(reader, patient, correction).expect(403);
      await save(outsider, patient, correction).expect(404);
      const historic = await fenced.api().get(`/api/v1/patients/${patient}/medications?entryId=${first.entryId}&version=1`).set(bearer(reader.token)).expect(200);
      expect(historic.body.items).toHaveLength(1);
      expect(await lab.count('patient_medications', 'patient_id=$1', [patient])).toBe(1);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', eventsChecked: 1, failures: [] });
    } finally {
      await fencedApp.close();
    }
    // The exact refused request can be saved once after reopening; fencing reserves no id.
    const saved = (await post(clinician, patient, correction).expect(201)).body;
    expect(saved).toMatchObject({ version: 2, source: 'clinician-entered' });
    expect((await post(clinician, patient, correction).expect(201)).body.id).toBe(saved.id);
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', eventsChecked: 2, failures: [] });
  });
  it('stores the canonical source name for a Tall Man drug, never its visual display form', async () => {
    const { clinician, patient } = await world();
    const record = (await post(clinician, patient, body({ rxcui: '991002', startMonth: undefined, stopMonth: undefined })).expect(201)).body;
    expect(record).toMatchObject({ name: 'hydroxyzine', startMonth: null, stopMonth: null });
    const rows = await withAdmin(db.adminUrl, (c) => c.query('SELECT drug_name FROM patient_medications WHERE id=$1', [record.id]));
    expect(rows.rows).toEqual([{ drug_name: 'hydroxyzine' }]);
    expect((await get(clinician, patient).expect(200)).body.items[0].name).toBe('hydroxyzine');
  });
  it('replays concurrent creates and corrections once; rejects request-id reuse and stale corrections', async () => {
    const { clinician, patient } = await world();
    const request = body();
    const created = await Promise.all(Array.from({ length: 6 }, () => post(clinician, patient, request)));
    expect(created.map((x) => x.status)).toEqual(Array(6).fill(201));
    expect(new Set(created.map((x) => x.body.id)).size).toBe(1);
    const first = created[0]!.body;
    const correction = body({ entryId: first.entryId, expectedVersion: 1, status: 'stopped' });
    const corrected = await Promise.all(Array.from({ length: 6 }, () => post(clinician, patient, correction)));
    expect(corrected.map((x) => x.status)).toEqual(Array(6).fill(201));
    expect(new Set(corrected.map((x) => x.body.id)).size).toBe(1);
    await post(clinician, patient, { ...request, source: 'clinician-entered' }).expect(409);
    await post(clinician, patient, body({ entryId: first.entryId, expectedVersion: 1 })).expect(409);
    const replayed = (await post(clinician, patient, request).expect(201)).body;
    expect(replayed).toMatchObject({ id: first.id, version: 1, current: false });
    expect(await lab.count('patient_medications', 'patient_id=$1', [patient])).toBe(2);
  });
  it('permits clinical reads, clinician writes; refuses admins, roleless members and other tenants', async () => {
    const { clinician, patient } = await world();
    await post(clinician, patient, body()).expect(201);
    for (const role of ['reader', 'reviewer'] as const) {
      const person = await lab.person(`SYN-${role}`, [role]);
      await get(person, patient).expect(200);
      await post(person, patient, body()).expect(403);
    }
    for (const roles of [['admin'], []] as Array<Array<'admin'>>) {
      const person = await lab.person(`SYN-denied-${roles.length}`, roles);
      await get(person, patient).expect(403);
      await post(person, patient, body()).expect(403);
    }
    const other = new LabPipeline(app, db.adminUrl);
    const outsider = await other.person('SYN-outsider', ['clinician']);
    await get(outsider, patient).expect(404);
    await post(outsider, patient, body()).expect(404);
  });
  it('rejects wrong entry/patient, unknown drugs, stale lists, unknown fields, invalid months and missing retry ids', async () => {
    const { clinician, patient } = await world();
    const first = (await post(clinician, patient, body()).expect(201)).body;
    const otherPatient = await lab.patient(clinician);
    await post(clinician, otherPatient, body({ entryId: first.entryId, expectedVersion: 1 })).expect(409);
    for (const change of [
      { rxcui: '991003' }, // Deliberately absent from the two-drug synthetic fixture.
      { name: NAME },
      { dose: NAME },
      { startMonth: '2026-13' },
      { startMonth: '2026-04', stopMonth: '2026-03', status: 'stopped' },
      { requestId: undefined },
    ])
      await post(clinician, patient, body(change)).expect(400);
    await post(clinician, patient, body({ listVersion: 'b'.repeat(64) })).expect(409);
    await get(clinician, patient, '?version=1').expect(400);
    await get(clinician, patient, `?entryId=${first.entryId}&version=999`).expect(404);
  });
  it('finds seeded medication values in no captured log, error body or security event', async () => {
    const { clinician, patient } = await world();
    await post(clinician, patient, body()).expect(201);
    const errors = [];
    errors.push((await post(clinician, patient, body({ rxcui: NAME })).expect(400)).text);
    errors.push((await post(clinician, patient, body({ [NAME]: NAME })).expect(400)).text);
    const denied = await lab.person('SYN-admin', ['admin']);
    errors.push((await get(denied, patient).expect(403)).text);
    const events = await withAdmin(
      db.adminUrl,
      async (c) =>
        (await c.query(`SELECT t::text FROM security_events t WHERE tenant_id=$1 UNION ALL SELECT t::text FROM security_audit_events t WHERE tenant_id=$1`, [lab.tenant])).rows,
    );
    expect(await lab.count('patient_medications', 'patient_id=$1 AND drug_name=$2', [patient, NAME])).toBe(1);
    expect(events.length).toBeGreaterThan(0);
    expect(logged.join('')).toContain('request completed');
    for (const text of [...errors, JSON.stringify(events), logged.join('')]) for (const needle of [NAME, '991001']) expect(text).not.toContain(needle);
  });
  it('detects tampering in a coded medication field in the ledger verification', async () => {
    const { clinician, patient } = await world();
    const row = (await post(clinician, patient, body()).expect(201)).body;
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
    await withAdmin(db.adminUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE patient_medications SET source='clinician-entered' WHERE id=$1`, [row.id]);
      await c.query('COMMIT');
    });
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'failed', failures: expect.arrayContaining([expect.objectContaining({ kind: 'payload-mismatch' })]) });
  });
});

describe('medication capture fails closed without its required dependencies', () => {
  it('returns 503 when the storage or verified list is unavailable', async () => {
    const app = await createTestApp({ medicationWrites: 'enabled', overrides: [{ provide: MEDICATION_DRUG_LIST, useValue: null }] });
    try {
      const lab = new LabPipeline(app, '');
      const clinician = await lab.person('SYN-clinician', ['clinician']);
      const patient = await lab.patient(clinician);
      const path = `/api/v1/patients/${patient}/medications`;
      if (!usingPostgres()) {
        await lab.api().get(path).set(bearer(clinician.token)).expect(503);
        await lab.api().post(path).set(bearer(clinician.token)).send(body()).expect(503);
      } else {
        // This createTestApp uses the run's default PostgreSQL backend; the missing artifact still refuses writes.
        await lab.api().post(path).set(bearer(clinician.token)).send(body()).expect(503);
      }
    } finally {
      await app.close();
    }
  });
});
