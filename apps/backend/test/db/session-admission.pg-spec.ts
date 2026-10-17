import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { Client, type PoolClient } from 'pg';
import request from 'supertest';
import { AuthGuard } from '../../src/auth/auth.guard';
import { asOrganizationWork, authorityContextMiddleware, bindRequestAuthority, currentRequestAuthority, type RequestAuthority } from '../../src/auth/authority-context';
import { BrowserSessionCustody } from '../../src/auth/browser-session';
import { SessionCrypto } from '../../src/auth/session-crypto';
import { Database } from '../../src/db/database';
import { PostgresBrowserSessionRepository } from '../../src/storage/postgres/browser-session.repository';
import { ObjectStorage } from '../../src/object-storage/object-storage';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registeringAdmin } from '../helpers/membership';
import { bearer, signToken } from '../helpers/tokens';

const TENANT = 'tenant-session-admission';
let pg: EphemeralDatabase;
let database: Database;
let otherDatabase: Database;
let repository: PostgresBrowserSessionRepository;
let otherRepository: PostgresBrowserSessionRepository;
let custody: BrowserSessionCustody;
let crypto: SessionCrypto;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: 'session-admission-writer' });
  otherDatabase = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: 'session-admission-revoker' });
  repository = new PostgresBrowserSessionRepository(database);
  otherRepository = new PostgresBrowserSessionRepository(otherDatabase);
  crypto = new SessionCrypto('admission', new Map([['admission', randomBytes(32)]]));
  custody = new BrowserSessionCustody(repository, crypto);
  // A fixture-only deferred trigger pauses COMMIT after Database has acquired both authority locks.
  // It proves the real transaction boundary without mocking Database, PoolClient or a lock query.
  await withAdmin(pg.adminUrl, c => c.query(`
    CREATE FUNCTION synthetic_admission_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.label LIKE 'SYN-BARRIER-%' THEN
        PERFORM pg_advisory_xact_lock(846017);
        IF NEW.label LIKE 'SYN-BARRIER-FAIL-%' THEN RAISE EXCEPTION 'synthetic commit refusal'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER synthetic_admission_commit_barrier AFTER INSERT ON patients
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_admission_commit_barrier();
  `));
});

afterAll(async () => {
  await database?.onModuleDestroy();
  await otherDatabase?.onModuleDestroy();
  await pg?.drop();
});

async function session(ttl = 60_000, skew = 0, tenant = TENANT) {
  const sub = `person-${randomUUID()}`;
  const member = await withAdmin(pg.adminUrl, c => registeringAdmin(c).grant({
    tenantId: tenant, sub, roles: ['clinician'], by: 'synthetic-fixture', reason: 'session admission test',
  }));
  const selectedCustody = skew ? new BrowserSessionCustody(repository, crypto, () => Date.now() + skew) : custody;
  const made = await selectedCustody.create({
    identity: { tenantId: tenant, sub, roles: [], issuedAt: Math.floor((Date.now() + Math.min(0, skew)) / 1000) - 1 },
    accessToken: 'synthetic-session-admission-token', tokenExpiresAt: new Date(Date.now() + ttl),
  });
  const row = (await selectedCustody.read(made.cookie))!;
  const authority = { sub, version: member.version, session: {
    tenantId: row.tenantId, handleHash: row.handleHash, issuedAt: row.issuedAt,
    createdAt: row.createdAt.getTime(), expiresAt: row.expiresAt.getTime(),
  } };
  return { authority, row, cookie: made.cookie };
}

function asRequest<T>(authority: RequestAuthority, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => authorityContextMiddleware({} as Request, {} as Response, () => {
    bindRequestAuthority(authority);
    work().then(resolve, reject);
  }));
}

const insert = (client: PoolClient, sub: string, id: string, label = `SYN-${id}`) => client.query(
  'INSERT INTO patients (id, tenant_id, label, created_by) VALUES ($1, $2, $3, $4)',
  [id, TENANT, label, sub],
).then(() => undefined);
const exists = (id: string) => withAdmin(pg.adminUrl, async c =>
  (await c.query('SELECT count(*)::int AS n FROM patients WHERE tenant_id=$1 AND id=$2', [TENANT, id])).rows[0].n > 0);

it('control: a current session and membership commit the protected write', async () => {
  const { authority } = await session();
  const id = randomUUID();
  await asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id)));
  expect(await exists(id)).toBe(true);
});

it('refuses a write from a session revoked after its custody snapshot and rolls it back whole', async () => {
  const { authority, row } = await session();
  const id = randomUUID();
  expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  await expect(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id))))
    .rejects.toMatchObject({ status: 401 });
  expect(await exists(id)).toBe(false);
});

async function application(operator = false) {
  const c = new Client({ connectionString: operator ? pg.adminUrl : pg.appUrl });
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
  return c;
}
async function close(c: Client) { await c.query('ROLLBACK').catch(() => undefined); await c.end(); }
async function blocked(applicationName: string, event?: string) {
  for (let i = 0; i < 200; i++) {
    const found = await withAdmin(pg.adminUrl, async c => (await c.query(
      "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock' AND ($3::text IS NULL OR wait_event=$3)",
      [pg.name, applicationName, event ?? null],
    )).rows[0]);
    if (found) return found as { pid: number; blockers: number[] };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected database-confirmed authority lock wait did not occur');
}
async function past(expiry: Date) {
  await withAdmin(pg.adminUrl, c => c.query('SELECT pg_sleep(greatest(0, extract(epoch FROM ($1::timestamptz - clock_timestamp())) + 0.03))', [expiry]));
  expect(await withAdmin(pg.adminUrl, async c => (await c.query('SELECT clock_timestamp() > $1::timestamptz AS expired', [expiry])).rows[0].expired)).toBe(true);
}
const result = (work: Promise<unknown>) => work.then(() => ({ status: 200, message: '' }), error => ({ status: error.status, message: error.message }));

it('revocation committed while work is in flight rolls back every write in the transaction', async () => {
  const { authority, row } = await session();
  const ids = [randomUUID(), randomUUID()];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = result(asRequest(authority, () => database.withTenant(TENANT, async c => {
    for (const id of ids) await insert(c, authority.sub, id);
    started(); await gate;
  })));
  try {
    await ready;
    expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  } finally { release(); }
  expect((await pending).status).toBe(401);
  for (const id of ids) expect(await exists(id)).toBe(false);
});

it.each([false, true])('a writer holding final admission orders revocation after its commit/rollback (rollback=%s)', async rollback => {
  const { authority, row } = await session();
  const id = randomUUID();
  const gate = await application();
  await gate.query('SELECT pg_advisory_lock(846017)');
  const pending = result(asRequest(authority, () => database.withTenant(TENANT,
    c => insert(c, authority.sub, id, `SYN-BARRIER-${rollback ? 'FAIL-' : ''}${id.slice(0, 20)}`))));
  let revocation: Promise<boolean> | undefined;
  try {
    const writer = await blocked('session-admission-writer', 'advisory');
    revocation = otherRepository.revoke(TENANT, row.handleHash);
    const revoker = await blocked('session-admission-revoker');
    expect(revoker.blockers).toContain(writer.pid);
    await gate.query('SELECT pg_advisory_unlock(846017)');
    const outcome = await pending;
    expect(outcome.status).toBe(rollback ? undefined : 200);
    if (rollback) expect(outcome.message).toBe('synthetic commit refusal');
    expect(await revocation).toBe(true);
    expect(await exists(id)).toBe(!rollback);
    const later = randomUUID();
    await expect(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, later)))).rejects.toMatchObject({ status: 401 });
    expect(await exists(later)).toBe(false);
  } finally {
    await gate.query('SELECT pg_advisory_unlock(846017)');
    await close(gate); await pending; await revocation;
  }
});

it.each(['session', 'membership'])('uses database expiry after waiting for the %s lock, even with an earlier live snapshot', async lock => {
  const { authority, row } = await session(1_100, -20_000);
  const id = randomUUID(), gate = await application(lock === 'membership');
  await gate.query(lock === 'session'
    ? 'SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2 FOR UPDATE'
    : 'SELECT sub FROM tenant_memberships WHERE tenant_id=$1 AND sub=$2 FOR UPDATE',
  [TENANT, lock === 'session' ? row.handleHash : authority.sub]);
  const pending = result(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id))));
  try {
    await blocked('session-admission-writer');
    await past(row.expiresAt);
    await gate.query('COMMIT');
    expect((await pending).status).toBe(401);
    expect(await exists(id)).toBe(false);
  } finally { await close(gate); await pending; }
});

it.each(['COMMIT', 'ROLLBACK'])('a waiting writer sees a revoker that finishes with %s', async finish => {
  const { authority, row } = await session();
  const id = randomUUID(), gate = await application();
  await gate.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND handle_hash=$2', [TENANT, row.handleHash]);
  const pending = result(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id))));
  try {
    await blocked('session-admission-writer');
    await gate.query(finish);
    expect((await pending).status).toBe(finish === 'COMMIT' ? 401 : 200);
    expect(await exists(id)).toBe(finish === 'ROLLBACK');
  } finally { await close(gate); await pending; }
});

it.each(['issuedAt', 'createdAt', 'expiresAt', 'handleHash', 'tenantId'])('refuses mismatched immutable session %s', async field => {
  const { authority } = await session();
  const id = randomUUID();
  const changed = { ...authority, session: { ...authority.session, [field]: field === 'handleHash' ? '0'.repeat(64)
    : field === 'tenantId' ? 'tenant-foreign' : authority.session[field as 'issuedAt' | 'createdAt' | 'expiresAt'] + 1 } };
  await expect(asRequest(changed, () => database.withTenant(TENANT, c => insert(c, authority.sub, id)))).rejects.toMatchObject({ status: 401 });
  expect(await exists(id)).toBe(false);
});

it('another active member cannot use the first member\'s session metadata', async () => {
  const first = await session(), second = await session();
  const id = randomUUID();
  const changed = { ...second.authority, session: first.authority.session };
  await expect(asRequest(changed, () => database.withTenant(TENANT, c => insert(c, changed.sub, id)))).rejects.toMatchObject({ status: 401 });
  expect(await exists(id)).toBe(false);
});

it('a foreign tenant session cannot replace an own-tenant session binding', async () => {
  const own = await session(), foreign = await session(60_000, 0, 'tenant-admission-foreign');
  const id = randomUUID();
  await expect(asRequest({ ...own.authority, session: foreign.authority.session }, () => database.withTenant(TENANT, c => insert(c, own.authority.sub, id))))
    .rejects.toMatchObject({ status: 401 });
  expect(await exists(id)).toBe(false);
});

it.each([-20_000, 25_000])('keeps accepted clock skew %s subject to final database-timed revocation', async skew => {
  const { authority, row } = await session(60_000, skew);
  const before = randomUUID(), after = randomUUID();
  await asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, before)));
  expect(await exists(before)).toBe(true);
  expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  await expect(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, after)))).rejects.toMatchObject({ status: 401 });
  expect(await exists(after)).toBe(false);
});

it('membership changes still refuse with 403, before session admission, and record the existing refusal', async () => {
  const { authority } = await session();
  const id = randomUUID();
  await withAdmin(pg.adminUrl, c => registeringAdmin(c).setRoles({ tenantId: TENANT, sub: authority.sub, roles: ['reader'], by: 'synthetic-fixture', reason: 'session race' }));
  const refused = jest.fn().mockResolvedValue(undefined);
  database.onAuthorityRefused = refused;
  try {
    await expect(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id)))).rejects.toMatchObject({ status: 403 });
    expect(refused).toHaveBeenCalledWith(TENANT, authority.sub);
    expect(await exists(id)).toBe(false);
  } finally { database.onAuthorityRefused = undefined; }
});

it('ordinary bearer writes do not inherit revocation of a different local session', async () => {
  const { authority, row } = await session();
  expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  const id = randomUUID();
  await asRequest({ sub: authority.sub, version: authority.version }, () => database.withTenant(TENANT, c => insert(c, authority.sub, id)));
  expect(await exists(id)).toBe(true);
});

it('read-only transactions keep admission-time read semantics; organization cleanup does not erase the request binding', async () => {
  const { authority, row } = await session();
  expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  const id = randomUUID();
  await asRequest(authority, async () => {
    await database.withTenant(TENANT, c => c.query('SELECT count(*) FROM patients'));
    await asOrganizationWork(() => database.withTenant(TENANT, c => insert(c, authority.sub, id)));
    expect(currentRequestAuthority()).toEqual(authority);
    await expect(database.withTenant(TENANT, c => insert(c, authority.sub, randomUUID()))).rejects.toMatchObject({ status: 401 });
  });
  expect(await exists(id)).toBe(true);
});

it('session lock timeout is sanitized as 503 and rolls the write back, then a retry succeeds', async () => {
  const { authority, row } = await session();
  const id = randomUUID(), gate = await application();
  await gate.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2 FOR UPDATE', [TENANT, row.handleHash]);
  try {
    const pending = result(asRequest(authority, () => database.withTenant(TENANT, async c => {
      await c.query("SET LOCAL lock_timeout='300ms'");
      await insert(c, authority.sub, id);
    })));
    await blocked('session-admission-writer');
    expect(await pending).toEqual({ status: 503, message: 'Access checks are unavailable.' });
    expect(await exists(id)).toBe(false);
  } finally { await close(gate); }
  await asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, id)));
  expect(await exists(id)).toBe(true);
});

it('session pool failure is 503 without exposing connection details', async () => {
  const { authority } = await session();
  const ended = new Database({ url: pg.appUrl, ssl: 'disable' });
  await ended.onModuleDestroy();
  await expect(asRequest(authority, () => ended.withTenant(TENANT, async () => undefined)))
    .rejects.toMatchObject({ status: 503, message: 'Access checks are unavailable.' });
});

it('pool reuse cannot leak a revoked session binding into a later bearer request', async () => {
  const { authority, row } = await session();
  const single = new Database({ url: pg.appUrl, ssl: 'disable', max: 1 });
  expect(await otherRepository.revoke(TENANT, row.handleHash)).toBe(true);
  const id = randomUUID();
  try {
    await expect(asRequest(authority, () => single.withTenant(TENANT, c => insert(c, authority.sub, randomUUID())))).rejects.toMatchObject({ status: 401 });
    await asRequest({ sub: authority.sub, version: authority.version }, () => single.withTenant(TENANT, c => insert(c, authority.sub, id)));
    expect(await exists(id)).toBe(true);
  } finally { await single.onModuleDestroy(); }
});

it('membership-first revocation and a role change complete without inverting the writer lock order', async () => {
  const { authority, row } = await session();
  const id = randomUUID(), gate = await application();
  const operator = new Client({ connectionString: pg.adminUrl, application_name: 'session-admission-membership-change' });
  await operator.connect();
  await gate.query('SELECT pg_advisory_lock(846017)');
  const writer = result(asRequest(authority, () => database.withTenant(TENANT,
    c => insert(c, authority.sub, id, `SYN-BARRIER-${id.slice(0, 20)}`))));
  let revoke: Promise<unknown> | undefined, change: Promise<unknown> | undefined;
  try {
    await blocked('session-admission-writer', 'advisory');
    // Model the future ordered revocation transaction explicitly, without enabling an HTTP logout path.
    revoke = otherDatabase.withTenant(TENANT, async c => {
      expect((await c.query('SELECT membership_assert_current($1,$2) AS ok', [authority.sub, authority.version])).rows[0].ok).toBe(true);
      return c.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND handle_hash=$2 AND revoked_at IS NULL', [TENANT, row.handleHash]);
    });
    await blocked('session-admission-revoker');
    change = operator.query("UPDATE tenant_memberships SET roles='{reader}' WHERE tenant_id=$1 AND sub=$2", [TENANT, authority.sub]);
    await blocked('session-admission-membership-change');
    await gate.query('SELECT pg_advisory_unlock(846017)');
    expect((await writer).status).toBe(200);
    await revoke; await change;
    expect(await exists(id)).toBe(true);
    await expect(asRequest(authority, () => database.withTenant(TENANT, c => insert(c, authority.sub, randomUUID())))).rejects.toMatchObject({ status: 403 });
  } finally {
    await gate.query('SELECT pg_advisory_unlock(846017)'); await close(gate);
    await writer; await revoke; await change; await operator.end();
  }
});

/** The real bearer guard still verifies identity/membership. Only this test adds a trusted internal session binding afterwards. */
async function boundApi() {
  const made = await session();
  const original = AuthGuard.prototype.canActivate;
  const spy = jest.spyOn(AuthGuard.prototype, 'canActivate').mockImplementation(async function (this: AuthGuard, context) {
    const allowed = await original.call(this, context);
    const authority = currentRequestAuthority();
    if (authority?.sub === made.authority.sub) bindRequestAuthority({ ...authority, session: made.authority.session });
    return allowed;
  });
  try {
    const app = await createTestApp({ postgresUrl: pg.appUrl, ownerUrl: pg.adminUrl, membershipFromTokens: false });
    const token = await signToken({ sub: made.authority.sub, tenant: TENANT });
    const api = () => request(app.getHttpServer());
    const bytes = Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');
    const patientId = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID()}` }).expect(201)).body.id;
    const reportId = (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId, type: 'vcf', filename: 'session.vcf', sizeBytes: bytes.length }).expect(201)).body.id;
    const revision = (await api().get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(token)).expect(200)).body.revision;
    const attempt = (await api().post(`/api/v1/reports/${reportId}/upload-attempts`).set(bearer(token)).send({ requestId: randomUUID(), revision,
      contentType: 'text/x-vcf', sha256: createHash('sha256').update(bytes).digest('hex') }).expect(201)).body as { attemptId: string; revision: string };
    return { ...made, app, api, token, bytes, reportId, attempt, dispose: async () => { spy.mockRestore(); await app.close(); } };
  } catch (error) { spy.mockRestore(); throw error; }
}

async function storedState(reportId: string, attemptId: string) {
  return withAdmin(pg.adminUrl, async c => (await c.query(`SELECT a.state, a.object_version AS attempt_version, r.object_version AS report_version, r.uploaded_at
    FROM report_upload_attempts a JOIN reports r ON r.tenant_id=a.tenant_id AND r.id=a.report_id
    WHERE a.tenant_id=$1 AND a.id=$2 AND r.id=$3`, [TENANT, attemptId, reportId])).rows[0]);
}

it('control: the real HTTP intake commits a version while session authority is current; cookies alone stay unauthorized', async () => {
  const rig = await boundApi();
  try {
    await rig.api().get('/api/v1/me').set('Cookie', `__Host-telesphoros-session=${rig.cookie}`).expect(401);
    const me = await rig.api().get('/api/v1/me').set(bearer(rig.token)).expect(200);
    expect(me.body).toEqual({ roles: ['clinician'] });
    await rig.api().put(`/api/v1/reports/${rig.reportId}/upload-attempts/${rig.attempt.attemptId}/bytes`)
      .set(bearer(rig.token)).set('X-Upload-Revision', rig.attempt.revision).set('Content-Type', 'text/x-vcf').send(rig.bytes).expect(200);
    const row = await storedState(rig.reportId, rig.attempt.attemptId);
    expect(row.state).toBe('committed');
    expect(typeof row.report_version).toBe('string'); expect(row.uploaded_at).toBeInstanceOf(Date);
  } finally { await rig.dispose(); }
});

it('revocation during raw HTTP intake refuses its next protected write while empty-transfer cleanup still finishes', async () => {
  const rig = await boundApi();
  const { port } = rig.app.getHttpServer().address() as AddressInfo;
  const transfer = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/v1/reports/${rig.reportId}/upload-attempts/${rig.attempt.attemptId}/bytes`,
    headers: { Authorization: `Bearer ${rig.token}`, 'X-Upload-Revision': rig.attempt.revision, 'Content-Type': 'text/x-vcf', 'Content-Length': rig.bytes.length } });
  const status = new Promise<number>((resolve, reject) => {
    transfer.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    transfer.on('error', reject);
  });
  try {
    transfer.write(rig.bytes.subarray(0, 10));
    let intaking = false;
    for (let i = 0; i < 100; i++) {
      if ((await storedState(rig.reportId, rig.attempt.attemptId)).state === 'intaking') { intaking = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(intaking).toBe(true);
    expect(await otherRepository.revoke(TENANT, rig.row.handleHash)).toBe(true);
    transfer.end(rig.bytes.subarray(10));
    expect(await status).toBe(401);
    expect(await storedState(rig.reportId, rig.attempt.attemptId)).toMatchObject({ state: 'cleaned', report_version: null, uploaded_at: null });
  } finally { transfer.destroy(); await status.catch(() => undefined); await rig.dispose(); }
});

it('revocation after object storage succeeds refuses the report pin and retains unresolved organization cleanup state', async () => {
  const rig = await boundApi();
  const storage = rig.app.get(ObjectStorage);
  const original = storage.inspect.bind(storage);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const spy = jest.spyOn(storage, 'inspect').mockImplementation(async (key, options) => {
    const inspected = await original(key, options); started(); await gate; return inspected;
  });
  const upload = rig.api().put(`/api/v1/reports/${rig.reportId}/upload-attempts/${rig.attempt.attemptId}/bytes`)
    .set(bearer(rig.token)).set('X-Upload-Revision', rig.attempt.revision).set('Content-Type', 'text/x-vcf').send(rig.bytes).then(res => res.status);
  try {
    await ready;
    expect(await otherRepository.revoke(TENANT, rig.row.handleHash)).toBe(true);
    release();
    expect(await upload).toBe(401);
    const row = await storedState(rig.reportId, rig.attempt.attemptId);
    expect(row).toMatchObject({ state: 'unresolved', report_version: null, uploaded_at: null });
    expect(typeof row.attempt_version).toBe('string');
  } finally { release(); spy.mockRestore(); await upload; await rig.dispose(); }
});
