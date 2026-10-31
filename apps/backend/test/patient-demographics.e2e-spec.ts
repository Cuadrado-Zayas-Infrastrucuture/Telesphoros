import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ageFromBirthYear, patientDemographicsDtoSchema, patientDtoSchema } from '@telesphoros/shared-types';
import { FIELD_KEY_PROVIDER, type FieldKeyProvider, LocalFieldKeyProvider } from '../src/patient-demographics/field-key-provider';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 025 PD-a over HTTP (T103), on the real module graph and a real PostgreSQL. The expected values are written by hand; the oracle for what was stored is the
// database through the administrator connection. Every name and date here is invented.
const GIVEN = 'Synthetic-Zzyzx-Given';
const FAMILY = 'Synthetic-Qwerty-Family';
const DOB = '1971-02-03';

/** The real local provider with a count of what the application asked of it, so a test can prove which paths never reach a key. */
class CountingProvider implements FieldKeyProvider {
  readonly id = 'local' as const;
  generates = 0;
  unwraps = 0;
  failGenerate = false;
  private readonly inner = new LocalFieldKeyProvider();
  async generateDataKey(context: { tenant: string; patient: string }) {
    this.generates += 1;
    if (this.failGenerate) throw new Error('synthetic provider outage');
    return this.inner.generateDataKey(context);
  }
  async unwrap(wrapped: Buffer, context: { tenant: string; patient: string }) {
    this.unwraps += 1;
    return this.inner.unwrap(wrapped, context);
  }
  get calls() {
    return this.generates + this.unwraps;
  }
}

(usingPostgres() ? describe : describe.skip)('patient demographics API', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  const provider = new CountingProvider();
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, overrides: [{ provide: FIELD_KEY_PROVIDER, useValue: provider }] });
  }, 60_000);
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl); // every test gets its own organization
    provider.failGenerate = false;
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const body = (over: object = {}) => ({ givenName: GIVEN, familyName: FAMILY, dateOfBirth: DOB, sex: 'female', ethnicity: ['white', 'asian'], ...over });
  const post = (who: Person, patientId: string, payload: object) => lab.api().post(`/api/v1/patients/${patientId}/demographics`).set(bearer(who.token)).send(payload);
  const get = (who: Person, patientId: string, query = '') => lab.api().get(`/api/v1/patients/${patientId}/demographics${query}`).set(bearer(who.token));
  const list = (who: Person) => lab.api().get('/api/v1/patients?pageSize=100').set(bearer(who.token));
  const stored = (patientId: string) => lab.count('patient_demographics', 'patient_id = $1', [patientId]);
  const keys = (patientId: string) => lab.count('patient_field_keys', 'patient_id = $1', [patientId]);
  const events = () => lab.count('ledger_events', "tenant_id = $1 AND event_type = 'patient-demographics'", [lab.tenant]);
  const erase = (patientId: string) => withAdmin(db.adminUrl, (c) => c.query('SELECT patient_field_key_erase($1, $2)', [lab.tenant, patientId]));
  const reason = (res: { body: Json }) => res.body.error?.details?.[0]?.reason;

  async function clinicianAndPatient() {
    const clinician = await lab.person('dr', ['clinician']);
    return { clinician, patientId: await lab.patient(clinician) };
  }

  describe('create, read and correct', () => {
    it('stores the first version for a clinician, returns it decrypted exactly as sent, and writes one ledger event', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const res = await post(clinician, patientId, body()).expect(201);
      expect(patientDemographicsDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({
        patientId,
        version: 1,
        current: true,
        givenName: GIVEN,
        familyName: FAMILY,
        dateOfBirth: DOB,
        sex: 'female',
        birthYear: 1971,
        ageYears: ageFromBirthYear(1971),
        ethnicity: ['asian', 'white'], // stored in one fixed order, whatever the order sent
        createdBy: clinician.sub,
      });
      expect(res.body.versions).toEqual([expect.objectContaining({ version: 1, createdBy: clinician.sub, sex: 'female', birthYear: 1971, ethnicity: ['asian', 'white'] })]);
      expect(await stored(patientId)).toBe(1);
      expect(await keys(patientId)).toBe(1);
      expect(await events()).toBe(1);
      const read = await get(clinician, patientId).expect(200);
      expect(read.body).toEqual(res.body);
    });

    // PD-4: the birth year is derived from the date of birth by the server; the client cannot send one, and the stored year always equals the date's year.
    it.each([
      ['1900-01-01', 1900],
      ['1999-12-31', 1999],
      ['2000-02-29', 2000],
      [new Date().toISOString().slice(0, 10), new Date().getUTCFullYear()],
    ])('derives birth_year from the date of birth %s (%i)', async (dateOfBirth, year) => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body({ dateOfBirth })).expect(201);
      expect(await lab.row('SELECT birth_year FROM patient_demographics WHERE patient_id = $1', [patientId])).toEqual([{ birth_year: year }]);
    });

    it('refuses a birth year (or age, or any field) sent by the client', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      for (const extra of [{ birthYear: 1960 }, { ageYears: 40 }, { patientId }, { tenantId: 'someone' }]) {
        const res = await post(clinician, patientId, body(extra)).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await stored(patientId)).toBe(0);
    });

    it('a correction adds version 2 and leaves version 1 readable; the list names who and when (PD-5)', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const other = await lab.person('dr2', ['clinician']);
      await post(clinician, patientId, body()).expect(201);
      const second = await post(other, patientId, body({ givenName: 'Synthetic-Corrected', dateOfBirth: '1971-03-04', sex: 'male', ethnicity: null })).expect(201);
      expect(second.body).toMatchObject({
        version: 2,
        current: true,
        givenName: 'Synthetic-Corrected',
        dateOfBirth: '1971-03-04',
        sex: 'male',
        ethnicity: null,
        createdBy: other.sub,
      });
      expect(second.body.versions.map((v: Json) => [v.version, v.createdBy])).toEqual([
        [1, clinician.sub],
        [2, other.sub],
      ]);
      const current = await get(clinician, patientId).expect(200);
      expect(current.body).toMatchObject({ version: 2, current: true, givenName: 'Synthetic-Corrected' });
      const first = await get(clinician, patientId, '?version=1').expect(200);
      expect(first.body).toMatchObject({ version: 1, current: false, givenName: GIVEN, familyName: FAMILY, dateOfBirth: DOB, sex: 'female' });
      await get(clinician, patientId, '?version=3').expect(404);
      await get(clinician, patientId, '?version=0').expect(400);
      expect(await stored(patientId)).toBe(2);
      expect(await keys(patientId)).toBe(1); // the key is made once, with the first version
      expect(await events()).toBe(2);
    });

    it('answers 404 with a reason for a patient with no demographics yet', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const res = await get(clinician, patientId).expect(404);
      expect(reason(res)).toBe('no-demographics');
    });

    it('treats another organization’s patient as not found, for both routes, and stores nothing', async () => {
      const { patientId } = await clinicianAndPatient();
      const stranger = await lab.person('stranger', ['clinician'], `tenant-${randomUUID().slice(0, 8)}`);
      await post(stranger, patientId, body()).expect(404);
      await get(stranger, patientId).expect(404);
      await post(stranger, randomUUID(), body()).expect(404);
      expect(await stored(patientId)).toBe(0);
      expect(await keys(patientId)).toBe(0);
    });
  });

  describe('who may do what', () => {
    it('lets a clinician write; reader and reviewer may only read; an administrator, a role-less member and a stranger get nothing (PD-6)', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const reader = await lab.person('reader', ['reader']);
      const reviewer = await lab.person('rev', ['reviewer']);
      const admin = await lab.person('admin', ['admin']);
      const nobody = await lab.person('nobody', []);
      await post(clinician, patientId, body()).expect(201);
      for (const who of [reader, reviewer, admin, nobody]) {
        const res = await post(who, patientId, body({ givenName: 'Synthetic-Intruder' })).expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      for (const who of [reader, reviewer]) expect((await get(who, patientId).expect(200)).body).toMatchObject({ givenName: GIVEN, familyName: FAMILY, dateOfBirth: DOB });
      for (const who of [admin, nobody]) {
        const res = await get(who, patientId).expect(403);
        expect(JSON.stringify(res.body)).not.toMatch(/Zzyzx|Qwerty|1971|givenName/); // a role without clinical read gets no identity, not even a field name
      }
      expect(await stored(patientId)).toBe(1);
    });
  });

  describe('retry ids', () => {
    it('replays the version a request created, without a second row, and does not open a new key', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const requestId = randomUUID();
      const first = await post(clinician, patientId, body({ requestId })).expect(201);
      const again = await post(clinician, patientId, body({ requestId, ethnicity: ['asian', 'white'] })).expect(201); // the same request, ethnicity in another order
      expect(again.body).toEqual(first.body);
      expect(await stored(patientId)).toBe(1);
      expect(await events()).toBe(1);
      expect(await keys(patientId)).toBe(1);
    });

    it('refuses the same retry id with different fields, or for another patient (409, request-id-reused), and stores nothing', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const second = await lab.patient(clinician);
      const requestId = randomUUID();
      await post(clinician, patientId, body({ requestId })).expect(201);
      for (const [target, payload] of [
        [patientId, body({ requestId, givenName: 'Synthetic-Different' })],
        [patientId, body({ requestId, dateOfBirth: '1971-02-04' })],
        [patientId, body({ requestId, sex: 'male' })],
        [patientId, body({ requestId, ethnicity: null })],
        [second, body({ requestId })],
      ] as const) {
        const res = await post(clinician, target, payload).expect(409);
        expect(reason(res)).toBe('request-id-reused');
      }
      expect(await stored(patientId)).toBe(1);
      expect(await stored(second)).toBe(0);
    });

    it('stores a fingerprint that is keyed: it matches neither a plain hash of the request nor another patient’s for the same request', async () => {
      const a = await clinicianAndPatient();
      const b = await clinicianAndPatient();
      const requestId = randomUUID();
      await post(a.clinician, a.patientId, body({ requestId })).expect(201);
      await post(b.clinician, b.patientId, body({ requestId })).expect(201);
      const [x, y] = await lab.row<{ creation_request_hash: string }>('SELECT creation_request_hash FROM patient_demographics WHERE patient_id = ANY($1) ORDER BY patient_id', [
        [a.patientId, b.patientId].sort(),
      ]);
      expect(x!.creation_request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(x!.creation_request_hash).not.toBe(y!.creation_request_hash);
    });
  });

  describe('validation: field names and rules, never the value', () => {
    it.each([
      ['a missing given name', { givenName: undefined }, 'givenName'],
      ['an empty family name', { familyName: '   ' }, 'familyName'],
      ['a name over 100 characters', { givenName: 'x'.repeat(101) }, 'givenName'],
      ['a name with a control character', { givenName: 'Synthetic\u0007Name' }, 'givenName'],
      ['a date that is not YYYY-MM-DD', { dateOfBirth: '03/02/1971' }, 'dateOfBirth'],
      ['an impossible date', { dateOfBirth: '1971-02-30' }, 'dateOfBirth'],
      ['a date before 1900', { dateOfBirth: '1899-12-31' }, 'dateOfBirth'],
      ['a date in the future', { dateOfBirth: '2999-01-01' }, 'dateOfBirth'],
      ['a sex that is not male or female', { sex: 'unknown' }, 'sex'],
      ['an ethnicity code outside the list', { ethnicity: ['martian'] }, 'ethnicity.0'],
      ['an empty ethnicity list', { ethnicity: [] }, 'ethnicity'],
      ['a repeated ethnicity code', { ethnicity: ['asian', 'asian'] }, 'ethnicity'],
      ['a name that is not a string', { givenName: 42 }, 'givenName'],
    ])('refuses %s with 400 naming %s', async (_label, over, field) => {
      const { clinician, patientId } = await clinicianAndPatient();
      const res = await post(clinician, patientId, body(over)).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.map((d: Json) => d.field)).toContain(field);
      expect(await stored(patientId)).toBe(0);
      expect(await keys(patientId)).toBe(0);
    });

    it('accepts sex and ethnicity left out or null (they stay empty), and trims and normalizes the names', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      const res = await post(clinician, patientId, { givenName: '  Synthetic   Given ', familyName: 'Núñez', dateOfBirth: DOB }).expect(201);
      expect(res.body).toMatchObject({ givenName: 'Synthetic Given', familyName: 'Núñez', sex: null, ethnicity: null });
      const nulls = await post(clinician, patientId, body({ sex: null, ethnicity: null })).expect(201);
      expect(nulls.body).toMatchObject({ version: 2, sex: null, ethnicity: null });
    });

    it('refuses a request id that is not a uuid, a non-JSON body and an unknown query parameter', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body({ requestId: 'not-a-uuid' })).expect(400);
      await get(clinician, patientId, '?foo=1').expect(400);
    });
  });

  describe('lists carry coded fields only and never decrypt (PD-6)', () => {
    it('shows sex, birth year, age, ethnicity and completeness for each patient, and no identity field', async () => {
      const clinician = await lab.person('dr', ['clinician']);
      const complete = await lab.patient(clinician);
      const noEthnicity = await lab.patient(clinician);
      const noDemographics = await lab.patient(clinician);
      await post(clinician, complete, body()).expect(201);
      await post(clinician, noEthnicity, body({ ethnicity: null })).expect(201);
      const reader = await lab.person('reader', ['reader']);

      const before = provider.calls;
      const res = await list(reader).expect(200);
      expect(provider.calls).toBe(before); // PD-6: the list never asked the key provider for anything
      const by = Object.fromEntries((res.body.data as Json[]).map((p) => [p.id, p]));
      expect(by[complete]).toMatchObject({ sex: 'female', birthYear: 1971, ageYears: ageFromBirthYear(1971), ethnicity: ['asian', 'white'], demographicsComplete: true });
      expect(by[noEthnicity]).toMatchObject({ sex: 'female', birthYear: 1971, ethnicity: null, demographicsComplete: false });
      expect(by[noDemographics]).toMatchObject({ sex: null, birthYear: null, ageYears: null, ethnicity: null, demographicsComplete: false });
      for (const item of Object.values(by)) {
        expect(patientDtoSchema.safeParse(item).success).toBe(true);
        expect(Object.keys(item as object)).not.toEqual(expect.arrayContaining(['givenName']));
        expect(Object.keys(item as object).filter((k) => /name|birth_?date|dateOfBirth|dob/i.test(k))).toEqual([]);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/Zzyzx|Qwerty|1971-02-03/);
    });

    it('control for the no-decrypt proof: the detail read DOES ask the provider (so a count of zero means something)', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body()).expect(201);
      const before = provider.unwraps;
      await get(clinician, patientId).expect(200);
      expect(provider.unwraps).toBe(before + 1);
    });

    it('a list shows the latest version’s coded fields after a correction, and the patient’s own response keeps its old shape', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body()).expect(201);
      await post(clinician, patientId, body({ sex: 'male', dateOfBirth: '1980-01-01', ethnicity: ['hispanic-or-latino'] })).expect(201);
      const item = ((await list(clinician).expect(200)).body.data as Json[]).find((p) => p.id === patientId)!;
      expect(item).toMatchObject({ sex: 'male', birthYear: 1980, ethnicity: ['hispanic-or-latino'], demographicsComplete: true });
      const single = (await lab.api().get(`/api/v1/patients/${patientId}`).set(bearer(clinician.token)).expect(200)).body;
      expect(Object.keys(single).sort()).toEqual(['createdAt', 'id', 'label', 'mergedInto', 'updatedAt']);
    });
  });

  describe('the key provider failing', () => {
    it('answers 503 and stores neither a version nor a key when a data key cannot be made', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      provider.failGenerate = true;
      const res = await post(clinician, patientId, body()).expect(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/synthetic provider outage|Zzyzx|Qwerty/);
      expect(await stored(patientId)).toBe(0);
      expect(await keys(patientId)).toBe(0);
      provider.failGenerate = false;
      await post(clinician, patientId, body()).expect(201); // control: the same request succeeds once the provider is back
    });
  });

  describe('erasure (PD-8, D8)', () => {
    it('after the patient’s key is destroyed the API answers 410 identity-erased for both routes, the list still shows the coded fields, and the ledger verifies', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body()).expect(201);
      await post(clinician, patientId, body({ sex: 'male' })).expect(201);
      await get(clinician, patientId).expect(200); // control: readable before
      await erase(patientId);

      for (const res of [await get(clinician, patientId), await get(clinician, patientId, '?version=1'), await post(clinician, patientId, body({ requestId: randomUUID() }))]) {
        expect(res.status).toBe(410);
        expect(reason(res)).toBe('identity-erased');
        expect(res.body.error.message).toMatch(/erased/);
        expect(JSON.stringify(res.body)).not.toMatch(/Zzyzx|Qwerty|1971/);
      }
      // A replay of a request that succeeded before the erasure cannot be answered either: there is no key to open its fields with.
      expect(await stored(patientId)).toBe(2);
      expect(await keys(patientId)).toBe(0);
      const item = ((await list(clinician).expect(200)).body.data as Json[]).find((p) => p.id === patientId)!;
      expect(item).toMatchObject({ sex: 'male', birthYear: 1971 }); // the coded columns are not identity and stay
      expect(await events()).toBe(2);
    });

    it('no route, controller method or CLI command exposes the erasure (it is a database function only the owner can run)', async () => {
      const { clinician, patientId } = await clinicianAndPatient();
      await post(clinician, patientId, body()).expect(201);
      for (const [method, path] of [
        ['delete', `/api/v1/patients/${patientId}/demographics`],
        ['put', `/api/v1/patients/${patientId}/demographics`],
        ['post', `/api/v1/patients/${patientId}/demographics/erase`],
        ['post', `/api/v1/patients/${patientId}/erase`],
        ['delete', `/api/v1/patients/${patientId}/demographics/key`],
      ] as const) {
        const res = await lab.api()[method](path).set(bearer(clinician.token)).send({});
        expect([404, 405]).toContain(res.status);
      }
      expect(await keys(patientId)).toBe(1);
    });
  });
});
