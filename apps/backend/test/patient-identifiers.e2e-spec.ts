import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { identifierDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { bearer, signToken } from './helpers/tokens';

/**
 * Patient identifiers (M2.1b, decision DP-4). The same file runs in memory and on PostgreSQL. An identifier's value is accepted once and
 * kept nowhere: no response carries it, and on PostgreSQL no row of any table does.
 */
let app: NestExpressApplication;
let db: EphemeralDatabase | undefined;
const api = () => request(app.getHttpServer());
const tenantOf = () => `org-${randomUUID().slice(0, 8)}`;
const as = async (tenant: string, roles: string[], sub = `person-${randomUUID().slice(0, 6)}`) => bearer(await signToken({ sub, roles, tenant }));
const newPatient = async (headers: Record<string, string>) => (await api().post('/api/v1/patients').set(headers).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id as string;
const register = (headers: Record<string, string>, patientId: string, system: string, value: string) =>
  api().post(`/api/v1/patients/${patientId}/identifiers`).set(headers).send({ system, value });
/** A number that cannot occur by accident anywhere else in the database or the logs. */
const secretNumber = () => `ZQX-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

beforeAll(async () => {
  if (usingPostgres()) {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
  } else {
    app = await createTestApp();
  }
});
afterAll(async () => {
  await app.close();
  await db?.drop();
});

describe('registering and listing', () => {
  it('registers an identifier and lists it without the value or the digest', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const patient = await newPatient(clin);
    const value = secretNumber();
    const made = await register(clin, patient, 'hospital-a-mrn', value).expect(201);
    expect(identifierDtoSchema.safeParse(made.body).success).toBe(true);
    expect(made.body).toMatchObject({ patientId: patient, system: 'hospital-a-mrn', status: 'active', withdrawnAt: null });
    const listed = await api().get(`/api/v1/patients/${patient}/identifiers`).set(clin).expect(200);
    expect(listed.body.data).toEqual([made.body]);
    for (const text of [JSON.stringify(made.body), JSON.stringify(listed.body)]) {
      expect(text).not.toContain(value);
      expect(text.toLowerCase()).not.toMatch(/digest|hmac|"value"/);
    }
  });

  it('treats white space and letter case as the same number, and punctuation as a different one (409 identifier-in-use)', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const first = await newPatient(clin);
    const second = await newPatient(clin);
    await register(clin, first, 'hospital-a-mrn', 'Mrn-7001').expect(201);
    for (const [patient, value] of [[first, '  mrn-7001'], [second, 'MRN-7001 ']] as const) {
      const res = await register(clin, patient, 'hospital-a-mrn', value);
      expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'identifier-in-use']);
    }
    await register(clin, second, 'hospital-a-mrn', 'MRN7001').expect(201); // control: not the same number
    await register(clin, second, 'hospital-b-mrn', 'MRN-7001').expect(201); // control: another system is another number
  });

  it('says the same thing for a number held by another patient as for one held by the same patient, and never names the holder', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const first = await newPatient(clin);
    const second = await newPatient(clin);
    await register(clin, first, 'hospital-a-mrn', 'SHARED-1').expect(201);
    const sameHolder = await register(clin, first, 'hospital-a-mrn', 'SHARED-1');
    const otherHolder = await register(clin, second, 'hospital-a-mrn', 'SHARED-1');
    expect({ ...sameHolder.body.error, requestId: undefined }).toEqual({ ...otherHolder.body.error, requestId: undefined });
    expect(JSON.stringify(otherHolder.body)).not.toContain(first);
  });

  it('keeps organizations apart: the same number in two organizations is two identifiers, and another organization\'s patient is a 404', async () => {
    const a = tenantOf();
    const b = tenantOf();
    const clinA = await as(a, ['clinician']);
    const clinB = await as(b, ['clinician']);
    const patientA = await newPatient(clinA);
    const patientB = await newPatient(clinB);
    await register(clinA, patientA, 'hospital-a-mrn', 'SAME-IN-BOTH').expect(201);
    await register(clinB, patientB, 'hospital-a-mrn', 'SAME-IN-BOTH').expect(201);
    expect((await register(clinB, patientA, 'hospital-a-mrn', 'ANOTHER-1')).status).toBe(404);
    expect((await api().get(`/api/v1/patients/${patientA}/identifiers`).set(clinB)).status).toBe(404);
    expect((await api().get(`/api/v1/patients/${randomUUID()}/identifiers`).set(clinA)).status).toBe(404);
  });

  it.each([
    [{ system: 'Hospital A', value: 'x' }],
    [{ system: '-bad', value: 'x' }],
    [{ system: 'a'.repeat(41), value: 'x' }],
    [{ system: 'hospital-a-mrn', value: '' }],
    [{ system: 'hospital-a-mrn', value: '   ' }],
    [{ system: 'hospital-a-mrn', value: 'x'.repeat(65) }],
    [{ system: 'hospital-a-mrn', value: 'bad\u0007value' }],
    [{ system: 'hospital-a-mrn' }],
    [{ value: 'x' }],
    [{ system: 'hospital-a-mrn', value: 'x', extra: 1 }],
  ])('refuses %j (400) and echoes no value', async (body) => {
    const clin = await as(tenantOf(), ['clinician']);
    const patient = await newPatient(clin);
    const res = await api().post(`/api/v1/patients/${patient}/identifiers`).set(clin).send(body);
    expect(res.status).toBe(400);
    if ('value' in body && typeof body.value === 'string' && body.value.trim().length > 3) expect(JSON.stringify(res.body)).not.toContain(body.value);
  });
});

describe('withdrawing', () => {
  it('withdraws an identifier, which frees its number for another patient, and keeps it listed as withdrawn', async () => {
    const clin = await as(tenantOf(), ['clinician']);
    const wrong = await newPatient(clin);
    const right = await newPatient(clin);
    const made = (await register(clin, wrong, 'hospital-a-mrn', 'TYPO-9001').expect(201)).body;
    expect((await register(clin, right, 'hospital-a-mrn', 'TYPO-9001')).status).toBe(409);
    await api().delete(`/api/v1/patients/${wrong}/identifiers/${made.id}`).set(clin).expect(204);
    await register(clin, right, 'hospital-a-mrn', 'TYPO-9001').expect(201);
    const listed = (await api().get(`/api/v1/patients/${wrong}/identifiers`).set(clin).expect(200)).body.data;
    expect(listed).toEqual([expect.objectContaining({ id: made.id, status: 'withdrawn', withdrawnAt: expect.any(String) })]);
  });

  it('answers 404 for an identifier that is not there, is on another patient, is withdrawn already, or belongs to another organization', async () => {
    const a = await as(tenantOf(), ['clinician']);
    const b = await as(tenantOf(), ['clinician']);
    const patient = await newPatient(a);
    const other = await newPatient(a);
    const made = (await register(a, patient, 'hospital-a-mrn', 'GONE-1').expect(201)).body;
    for (const [headers, path] of [
      [a, `/api/v1/patients/${patient}/identifiers/${randomUUID()}`],
      [a, `/api/v1/patients/${other}/identifiers/${made.id}`],
      [b, `/api/v1/patients/${patient}/identifiers/${made.id}`],
    ] as const) expect((await api().delete(path).set(headers)).status).toBe(404);
    await api().delete(`/api/v1/patients/${patient}/identifiers/${made.id}`).set(a).expect(204);
    expect((await api().delete(`/api/v1/patients/${patient}/identifiers/${made.id}`).set(a)).status).toBe(404);
  });
});

describe('who may do what', () => {
  it('registers and withdraws for a clinician only; a reader, reviewer, administrator or person with no role is refused, and a reader may list', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const patient = await newPatient(clin);
    const made = (await register(clin, patient, 'hospital-a-mrn', 'ROLE-1').expect(201)).body;
    for (const roles of [['reader'], ['reviewer'], ['admin'], []]) {
      const who = await as(tenant, roles);
      expect([roles, (await register(who, patient, 'hospital-a-mrn', 'ROLE-2')).status]).toEqual([roles, 403]);
      expect([roles, (await api().delete(`/api/v1/patients/${patient}/identifiers/${made.id}`).set(who)).status]).toEqual([roles, 403]);
    }
    for (const roles of [['reader'], ['reviewer'], ['clinician']]) expect((await api().get(`/api/v1/patients/${patient}/identifiers`).set(await as(tenant, roles))).status).toBe(200);
    for (const roles of [['admin'], []]) expect((await api().get(`/api/v1/patients/${patient}/identifiers`).set(await as(tenant, roles))).status).toBe(403);
    expect((await register(await as(tenant, ['admin', 'clinician']), patient, 'hospital-a-mrn', 'ROLE-3')).status).toBe(201); // control: both roles
    await api().post(`/api/v1/patients/${patient}/identifiers`).send({ system: 'hospital-a-mrn', value: 'x' }).expect(401);
  });
});

(usingPostgres() ? describe : describe.skip)('on PostgreSQL: the value is kept nowhere', () => {
  it('appears in no row of any table, and every stored digest is the same size whatever the value', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const patient = await newPatient(clin);
    const value = secretNumber();
    const longer = `${secretNumber()}-${'9'.repeat(30)}`;
    await register(clin, patient, 'hospital-a-mrn', value).expect(201);
    await register(clin, patient, 'hospital-a-mrn', longer).expect(201);
    await register(clin, patient, 'hospital-a-mrn', value).expect(409); // the refusal stores nothing either
    await withAdmin(db!.adminUrl, async (c) => {
      // Every table of the database, as the owner (a superuser sees past row-level security), for either value in any column.
      const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename as string);
      expect(tables).toContain('patient_identifiers'); // control: the scan covers the table that matters
      const hits: string[] = [];
      for (const table of tables) {
        for (const needle of [value, longer]) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text ILIKE $1`, [`%${needle}%`]);
          if (rows[0].n > 0) hits.push(`${table}: ${needle}`);
        }
      }
      expect(hits).toEqual([]);
      // Control: the scan can see a value that IS stored (the patient's label).
      const label = (await c.query(`SELECT label FROM patients WHERE id = $1`, [patient])).rows[0].label as string;
      expect((await c.query(`SELECT count(*)::int AS n FROM patients t WHERE t::text ILIKE $1`, [`%${label}%`])).rows[0].n).toBe(1);
      expect((await c.query(`SELECT DISTINCT octet_length(value_digest) AS n FROM patient_identifiers WHERE tenant_id = $1`, [tenant])).rows).toEqual([{ n: 32 }]);
    });
  });
});
