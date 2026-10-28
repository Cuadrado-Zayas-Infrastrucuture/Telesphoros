import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { revertThrough, versionsAfter } from '../helpers/migration-history';
import { bearer, clinicianA, readerA } from '../helpers/tokens';

let pg: EphemeralDatabase;
let app: NestExpressApplication;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  app = await createTestApp({ postgresUrl: pg.appUrl });
});
afterAll(async () => {
  await app?.close();
  await pg?.drop();
});

const api = () => request(app.getHttpServer());
const events = (id: string) =>
  withAdmin(
    pg.adminUrl,
    async (c) =>
      (await c.query('SELECT event_type,outcome,tenant_id,actor_sub,route_key,subject_id,request_id FROM security_audit_events WHERE request_id=$1 ORDER BY occurred_at,id', [id]))
        .rows,
  );

it('durably distinguishes API authentication from a private read without storing request content', async () => {
  const id = 'synthetic-audit-read-001';
  await api()
    .get('/api/v1/me?ignored=secret-value')
    .set(bearer(await clinicianA()))
    .set('X-Request-Id', id)
    .expect(400);
  const rows = await events(id);
  expect(rows).toEqual([
    expect.objectContaining({ event_type: 'api-auth', outcome: 'accepted', tenant_id: 'tenant-user-a', actor_sub: 'user-a', request_id: id }),
    expect.objectContaining({ event_type: 'private-read', outcome: 'refused', tenant_id: 'tenant-user-a', actor_sub: 'user-a', request_id: id }),
  ]);
  expect(JSON.stringify(rows)).not.toContain('secret-value');
});

it('records API refusal without asserting a tenant or an IdP login', async () => {
  const id = 'synthetic-audit-auth-001';
  await api().get('/api/v1/me').set('X-Request-Id', id).expect(401);
  expect(await events(id)).toEqual([
    expect.objectContaining({
      event_type: 'api-auth',
      outcome: 'refused',
      tenant_id: null,
      actor_sub: null,
      route_key: 'MeController.me',
      subject_id: null,
      request_id: id,
    }),
  ]);
});

it('records successful private reads and refused download links with opaque subject IDs', async () => {
  const token = await clinicianA();
  const readId = 'synthetic-audit-good-001';
  await api().get('/api/v1/me').set(bearer(token)).set('X-Request-Id', readId).expect(200);
  expect((await events(readId)).map((row) => [row.event_type, row.outcome])).toEqual([
    ['api-auth', 'accepted'],
    ['private-read', 'succeeded'],
  ]);

  const reportId = '2e40eac9-bc8e-4d41-a319-c70775c941aa';
  const refusedId = 'synthetic-audit-link-001';
  await api()
    .get(`/api/v1/reports/${reportId}/download-url`)
    .set(bearer(await readerA()))
    .set('X-Request-Id', refusedId)
    .expect(403);
  expect(await events(refusedId)).toEqual([
    expect.objectContaining({ event_type: 'api-auth', outcome: 'accepted' }),
    expect.objectContaining({ event_type: 'download-link', outcome: 'refused', subject_id: reportId }),
  ]);
});

it('records a real exact-version download-link issuance before the link leaves the API', async () => {
  const token = await clinicianA();
  const bytes = Buffer.from('{"synthetic":true}');
  const patientId = (
    await api()
      .post('/api/v1/patients')
      .set(bearer(token))
      .send({ label: `SYN-AUDIT-${randomUUID().slice(0, 8)}` })
      .expect(201)
  ).body.id as string;
  const reportId = (
    await api()
      .post('/api/v1/reports')
      .set(bearer(token))
      .send({
        patientId,
        type: 'structured',
        filename: 'synthetic.json',
        sizeBytes: bytes.length,
      })
      .expect(201)
  ).body.id as string;
  const revision = (await api().get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(token)).expect(200)).body.revision as string;
  const declaration = (
    await api()
      .post(`/api/v1/reports/${reportId}/upload-attempts`)
      .set(bearer(token))
      .send({
        requestId: randomUUID(),
        revision,
        contentType: 'application/json',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      .expect(201)
  ).body as { attemptId: string; revision: string };
  await api()
    .put(`/api/v1/reports/${reportId}/upload-attempts/${declaration.attemptId}/bytes`)
    .set(bearer(token))
    .set('X-Upload-Revision', declaration.revision)
    .set('Content-Type', 'application/json')
    .send(bytes.toString('utf8'))
    .expect(200);
  const id = 'synthetic-audit-issued-001';
  const link = await api().get(`/api/v1/reports/${reportId}/download-url`).set(bearer(token)).set('X-Request-Id', id).expect(200);
  expect(link.body.url).toEqual(expect.any(String));
  expect(await events(id)).toEqual([
    expect.objectContaining({ event_type: 'api-auth', outcome: 'accepted' }),
    expect.objectContaining({ event_type: 'download-link', outcome: 'succeeded', subject_id: reportId }),
  ]);
  expect(JSON.stringify(await events(id))).not.toContain(link.body.url);
});

it('prevents the restricted app role from reading or editing audit rows', async () => {
  const appClient = new Client({ connectionString: pg.appUrl });
  await appClient.connect();
  try {
    for (const sql of [
      'SELECT * FROM security_audit_events',
      'UPDATE security_audit_events SET outcome=outcome',
      'DELETE FROM security_audit_events',
      'TRUNCATE security_audit_events',
    ]) {
      await expect(appClient.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  } finally {
    await appClient.end();
  }
  await withAdmin(pg.adminUrl, async (c) => {
    await expect(c.query("UPDATE security_audit_events SET outcome='refused'")).rejects.toMatchObject({ code: '23000' });
  });
});

it('refuses rollback of populated audit evidence without deleting it', async () => {
  const before = await withAdmin(pg.adminUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM security_audit_events')).rows[0].n as number);
  expect(before).toBeGreaterThan(0);
  // The newer migrations (0021 merges, 0020 patient links, 0019 tenants, 0018 security events, 0017 membership) also refuse to be dropped with rows in them; allow those two on purpose so the audit table's own guard is what is tested.
  await expect(
    withAdmin(pg.adminUrl, async (c) => {
      await c.query(`SET telesphoros.allow_membership_drop = 'yes'`);
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      return migrateDown(c, revertThrough('security_access_audit').steps);
    }),
  ).rejects.toThrow(/Refusing to drop populated security audit events/);
  await withAdmin(pg.adminUrl, (c) => migrateUp(c)); // 0021, 0020, 0019, 0018 and 0017 were reverted on the way to the audit migration's guard: put them back (their rows were removed with them, which this test does not use)
  const after = await withAdmin(pg.adminUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM security_audit_events')).rows[0].n as number);
  expect(after).toBe(before);
});

it('withholds a successful private response when the audit writer cannot persist its read event', async () => {
  const id = 'synthetic-audit-fail-001';
  await withAdmin(pg.adminUrl, (c) => c.query("ALTER TABLE security_audit_events ADD CONSTRAINT test_refuse_private_read CHECK (event_type <> 'private-read') NOT VALID"));
  try {
    const response = await api()
      .get('/api/v1/me')
      .set(bearer(await clinicianA()))
      .set('X-Request-Id', id)
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('user-a');
    expect((await events(id)).map((row) => [row.event_type, row.outcome])).toEqual([['api-auth', 'accepted']]);
  } finally {
    await withAdmin(pg.adminUrl, (c) => c.query('ALTER TABLE security_audit_events DROP CONSTRAINT test_refuse_private_read'));
  }
  await api()
    .get('/api/v1/me')
    .set(bearer(await clinicianA()))
    .expect(200);
});

it('records a private write BEFORE it runs, with the route and the id in the path, and no body or field', async () => {
  const token = await clinicianA();
  const label = `SYN-WRITE-${randomUUID().slice(0, 8)}`;
  const createId = 'synthetic-audit-write-001';
  const created = await api().post('/api/v1/patients').set(bearer(token)).set('X-Request-Id', createId).send({ label }).expect(201);
  const patientId = created.body.id as string;
  expect(await events(createId)).toEqual([
    expect.objectContaining({ event_type: 'api-auth', outcome: 'accepted' }),
    expect.objectContaining({
      event_type: 'private-write',
      outcome: 'accepted',
      tenant_id: 'tenant-user-a',
      actor_sub: 'user-a',
      route_key: 'PatientsController.create',
      subject_id: null,
      request_id: createId,
    }),
  ]);
  const replaceId = 'synthetic-audit-write-002';
  await api()
    .put(`/api/v1/patients/${patientId}`)
    .set(bearer(token))
    .set('X-Request-Id', replaceId)
    .send({ label: `${label}-B` })
    .expect(200);
  expect((await events(replaceId)).map((row) => [row.event_type, row.outcome, row.route_key, row.subject_id])).toEqual([
    ['api-auth', 'accepted', 'PatientsController.replace', null],
    ['private-write', 'accepted', 'PatientsController.replace', patientId],
  ]);
  const removeId = 'synthetic-audit-write-003';
  await api().delete(`/api/v1/patients/${patientId}`).set(bearer(token)).set('X-Request-Id', removeId).expect(204);
  expect((await events(removeId)).map((row) => [row.event_type, row.subject_id])).toEqual([
    ['api-auth', null],
    ['private-write', patientId],
  ]);
  expect(JSON.stringify([await events(createId), await events(replaceId)])).not.toContain(label);
});

it('does not perform a write whose audit row cannot be stored', async () => {
  const token = await clinicianA();
  const label = `SYN-NOWRITE-${randomUUID().slice(0, 8)}`;
  const id = 'synthetic-audit-write-fail-001';
  await withAdmin(pg.adminUrl, (c) => c.query("ALTER TABLE security_audit_events ADD CONSTRAINT test_refuse_private_write CHECK (event_type <> 'private-write') NOT VALID"));
  try {
    const response = await api().post('/api/v1/patients').set(bearer(token)).set('X-Request-Id', id).send({ label }).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('user-a');
    expect((await events(id)).map((row) => [row.event_type, row.outcome])).toEqual([['api-auth', 'accepted']]);
  } finally {
    await withAdmin(pg.adminUrl, (c) => c.query('ALTER TABLE security_audit_events DROP CONSTRAINT test_refuse_private_write'));
  }
  // Nothing was created: the label is free, and the same request now goes through.
  await api().post('/api/v1/patients').set(bearer(token)).send({ label }).expect(201);
});

it('records a write refused for its role, with the route and the id in the path, and answers 403', async () => {
  const token = await readerA();
  const createId = 'synthetic-audit-write-refused-001';
  await api().post('/api/v1/patients').set(bearer(token)).set('X-Request-Id', createId).send({ label: 'SYN-REFUSED' }).expect(403);
  expect(await events(createId)).toEqual([
    expect.objectContaining({ event_type: 'api-auth', outcome: 'accepted' }),
    expect.objectContaining({
      event_type: 'private-write',
      outcome: 'refused',
      tenant_id: 'tenant-user-a',
      actor_sub: 'user-a',
      route_key: 'PatientsController.create',
      subject_id: null,
      request_id: createId,
    }),
  ]);
  const patientId = randomUUID();
  const removeId = 'synthetic-audit-write-refused-002';
  await api().delete(`/api/v1/patients/${patientId}`).set(bearer(token)).set('X-Request-Id', removeId).expect(403);
  expect((await events(removeId)).map((row) => [row.event_type, row.outcome, row.route_key, row.subject_id])).toEqual([
    ['api-auth', 'accepted', 'PatientsController.remove', null],
    ['private-write', 'refused', 'PatientsController.remove', patientId],
  ]);
  expect(JSON.stringify(await events(createId))).not.toContain('SYN-REFUSED');
});

it('allows the new event type only as an accepted or refused write, and the constraint is validated', async () => {
  const appClient = new Client({ connectionString: pg.appUrl });
  await appClient.connect();
  try {
    const call = (type: string, outcome: string, subject: string | null) =>
      appClient.query('SELECT public.security_audit_record($1,$2,$3,$4,$5,$6,$7)', [
        type,
        outcome,
        'tenant-user-a',
        'user-a',
        'ProbeController.write',
        subject,
        `synthetic-check-${randomUUID().slice(0, 8)}`,
      ]);
    await call('private-write', 'accepted', randomUUID());
    await call('private-write', 'accepted', null);
    await call('private-write', 'refused', randomUUID());
    await call('private-write', 'refused', null);
    for (const [type, outcome] of [
      ['private-write', 'succeeded'],
      ['api-auth', 'succeeded'],
      ['private-edit', 'accepted'],
    ]) {
      await expect(call(type!, outcome!, null)).rejects.toMatchObject({ code: '23514' });
    }
  } finally {
    await appClient.end();
  }
  await withAdmin(pg.adminUrl, async (c) => {
    const row = (await c.query("SELECT convalidated FROM pg_constraint WHERE conname = 'security_audit_kind' AND conrelid = 'public.security_audit_events'::regclass")).rows;
    expect(row).toEqual([{ convalidated: true }]);
  });
});

it('refuses to narrow the CHECK again while refused-write evidence exists, and reverts only when told to', async () => {
  const refused = async () =>
    withAdmin(
      pg.adminUrl,
      async (c) => (await c.query("SELECT count(*)::int AS n FROM security_audit_events WHERE event_type='private-write' AND outcome='refused'")).rows[0].n as number,
    );
  const before = await refused();
  expect(before).toBeGreaterThan(0);
  const { steps, reverted } = revertThrough('security_audit_refused_write');
  await expect(withAdmin(pg.adminUrl, (c) => migrateDown(c, steps))).rejects.toThrow(/Refusing to narrow the access-audit CHECK while refused private-write evidence exists/);
  expect(await refused()).toBe(before);
  // Each version reverts in its own transaction: the ones above 0052 (0053's down is a no-op) went before 0052 refused. Put them back.
  expect(await withAdmin(pg.adminUrl, (c) => migrateUp(c))).toEqual(versionsAfter('security_audit_refused_write'));
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query("SET telesphoros.allow_audit_drop = 'yes'");
    expect(await migrateDown(c, steps)).toEqual(reverted);
    // The old CHECK is back for new rows; the refused rows stay as evidence, so it is left NOT VALID.
    const row = (await c.query("SELECT convalidated FROM pg_constraint WHERE conname = 'security_audit_kind' AND conrelid = 'public.security_audit_events'::regclass")).rows;
    expect(row).toEqual([{ convalidated: false }]);
    expect(await migrateUp(c)).toEqual([...reverted].reverse());
  });
  expect(await refused()).toBe(before);
});
