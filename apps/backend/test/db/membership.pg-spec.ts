import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import request from 'supertest';
import { asOrganizationWork, authorityContextMiddleware, bindRequestAuthority, currentRequestAuthority, type RequestAuthority } from '../../src/auth/authority-context';
import { MembershipService } from '../../src/auth/membership.service';
import { Database } from '../../src/db/database';
import { runMembership } from '../../src/membership/membership-cli';
import type { MembershipAdmin } from '../../src/membership/membership';
import { InMemorySecurityEvents } from '../../src/security-events/security-events';
import { PostgresMembershipRepository } from '../../src/storage/postgres/membership.repository';
import { ReportsRepository } from '../../src/storage/reports.repository';
import { createTestApp, membershipOf } from '../helpers/app';
import { registeringAdmin, registerTenantRow } from '../helpers/membership';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { bearer, clinicianA } from '../helpers/tokens';

const TENANT = 'tenant-membership-pg';
const OPERATOR = { by: 'operator-test', reason: 'test' };
let db: EphemeralDatabase;
let database: Database;

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable', applicationName: 'membership-pg-spec' });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

const person = () => `person-${randomUUID().slice(0, 8)}`;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const admin = async <T>(work: (a: MembershipAdmin) => Promise<T>) => owner((c) => work(registeringAdmin(c)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function asApplication<T>(work: (c: Client) => Promise<T>, tenant: string | null = TENANT): Promise<T> {
  const client = new Client({ connectionString: db.appUrl });
  await client.connect();
  try {
    if (tenant !== null) await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenant]);
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Runs `work` the way a request does: inside the per-request slot, with the membership the guard resolved. */
function asRequest<T>(authority: RequestAuthority, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    authorityContextMiddleware({} as Request, {} as Response, () => {
      bindRequestAuthority(authority);
      work().then(resolve, reject);
    });
  });
}

describe('the membership table', () => {
  const insert = async (c: Client, tenant: string, sub: string, extra = '') => {
    await registerTenantRow(c, tenant);
    return c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', '{reader}', 'test') ${extra}`, [tenant, sub]);
  };

  it('lets the application login READ only its own organization, and nothing else', async () => {
    const a = person();
    const b = person();
    await owner(async (c) => {
      await insert(c, 'tenant-pg-a', a);
      await insert(c, 'tenant-pg-b', b);
    });
    expect(await asApplication((c) => c.query('SELECT sub FROM tenant_memberships'), 'tenant-pg-a').then((r) => r.rows.map((x) => x.sub))).toEqual([a]);
    expect(await asApplication((c) => c.query('SELECT sub FROM tenant_memberships'), null).then((r) => r.rows)).toEqual([]); // no organization bound: no rows
    for (const statement of [
      `INSERT INTO tenant_memberships (tenant_id, sub, status, changed_by) VALUES ('tenant-pg-a', 'self-grant', 'active', 'app')`,
      `UPDATE tenant_memberships SET roles = '{admin}'`,
      `DELETE FROM tenant_memberships`,
      `TRUNCATE tenant_memberships`,
    ]) {
      await expect(asApplication((c) => c.query(statement), 'tenant-pg-a')).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses, even to its owner: deleting or truncating a membership, moving its key, and moving a revocation instant backwards', async () => {
    const who = person();
    await owner(async (c) => {
      await insert(c, TENANT, who);
      await expect(c.query('DELETE FROM tenant_memberships WHERE sub = $1', [who])).rejects.toMatchObject({ code: '23000' });
      // Session custody references memberships: PostgreSQL refuses plain TRUNCATE before triggers run.
      await expect(c.query('TRUNCATE tenant_memberships')).rejects.toMatchObject({ code: '0A000' });
      // Explicitly reach the tombstone trigger too; CASCADE must not bypass it.
      await expect(c.query('TRUNCATE tenant_memberships CASCADE')).rejects.toMatchObject({ code: '23000' });
      expect((await c.query('SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND sub=$2', [TENANT, who])).rows[0].n).toBe(1);
      await expect(c.query('UPDATE tenant_memberships SET sub = $2 WHERE sub = $1', [who, 'someone-else'])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query('UPDATE tenant_memberships SET tenant_id = $2 WHERE sub = $1', [who, 'tenant-elsewhere'])).rejects.toMatchObject({ code: '23000' });
      await c.query(`UPDATE tenant_memberships SET tokens_valid_after = now() WHERE sub = $1`, [who]);
      await expect(c.query(`UPDATE tenant_memberships SET tokens_valid_after = now() - interval '1 hour' WHERE sub = $1`, [who])).rejects.toMatchObject({ code: '23000' });
    });
  });

  it('bumps the version on every change, whoever makes it', async () => {
    const who = person();
    await owner(async (c) => {
      await insert(c, TENANT, who);
      await c.query(`UPDATE tenant_memberships SET roles = '{clinician}' WHERE sub = $1`, [who]);
      await c.query(`UPDATE tenant_memberships SET roles = '{admin}', version = 1 WHERE sub = $1`, [who]); // a hand-written version is overwritten
      expect((await c.query('SELECT version FROM tenant_memberships WHERE sub = $1', [who])).rows[0].version).toBe('3');
    });
  });

  it('holds the rules the operator command relies on: one active organization per person, known roles only, bounded text', async () => {
    const who = person();
    await owner(async (c) => {
      await insert(c, 'tenant-one-a', who);
      await expect(insert(c, 'tenant-one-b', who)).rejects.toMatchObject({ code: '23505', constraint: 'tenant_memberships_one_active_uq' });
      await c.query(`UPDATE tenant_memberships SET status = 'removed' WHERE sub = $1`, [who]);
      await insert(c, 'tenant-one-b', who); // control: allowed once the first is removed
      await expect(c.query(`UPDATE tenant_memberships SET roles = '{superuser}' WHERE sub = $1 AND tenant_id = 'tenant-one-b'`, [who])).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`UPDATE tenant_memberships SET roles = '{reader,clinician,admin,reviewer,reader}' WHERE sub = $1 AND tenant_id = 'tenant-one-b'`, [who])).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`UPDATE tenant_memberships SET status = 'suspended' WHERE sub = $1 AND tenant_id = 'tenant-one-b'`, [who])).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`UPDATE tenant_memberships SET reason = $2 WHERE sub = $1 AND tenant_id = 'tenant-one-b'`, [who, 'x'.repeat(501)])).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('keeps the commit-time check callable by the application role and nobody else, and out of reach of other organizations', async () => {
    const who = person();
    await owner((c) => insert(c, TENANT, who));
    const call = (tenant: string | null, sub: string, version: number) =>
      asApplication((c) => c.query('SELECT membership_assert_current($1, $2) AS ok', [sub, version]), tenant).then((r) => r.rows[0].ok);
    expect(await call(TENANT, who, 1)).toBe(true);
    expect(await call(TENANT, who, 2)).toBe(false); // the row has not moved to version 2
    expect(await call('tenant-elsewhere', who, 1)).toBe(false); // reads only the bound organization
    expect(await call(null, who, 1)).toBe(false); // no organization bound
    expect(await call(TENANT, 'nobody', 1)).toBe(false);
    await owner(async (c) => {
      await c.query(`UPDATE tenant_memberships SET status = 'removed' WHERE sub = $1`, [who]);
      for (const role of ['telesphoros_ledger_verifier', 'telesphoros_ledger_operator']) {
        expect((await c.query(`SELECT has_function_privilege($1, 'membership_assert_current(text,bigint)', 'EXECUTE') AS ok`, [role])).rows[0].ok).toBe(false);
      }
      expect((await c.query(`SELECT has_function_privilege('telesphoros_app', 'membership_assert_current(text,bigint)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
    });
    expect(await call(TENANT, who, 2)).toBe(false); // removed
  });
});

describe('the commit boundary for writes', () => {
  async function newMember(roles: ('clinician' | 'reader')[] = ['clinician']) {
    const sub = person();
    const record = await admin((a) => a.grant({ tenantId: TENANT, sub, roles, ...OPERATOR }));
    return { sub, version: record.version };
  }
  const label = () => `SYN-${randomUUID().slice(0, 12)}`;
  const insertPatient = (client: Client, sub: string, name: string) =>
    client.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $2, $3)`, [TENANT, sub, name]);
  const exists = async (name: string) =>
    (await owner((c) => c.query(`SELECT count(*)::int AS n FROM patients WHERE tenant_id = $1 AND label = $2`, [TENANT, name]))).rows[0].n === 1;

  it('refuses a write whose person was removed after the request was admitted, and rolls ALL of it back', async () => {
    const { sub, version } = await newMember();
    const name = label();
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = asRequest({ sub, version }, () =>
      database.withTenant(TENANT, async (client) => {
        await insertPatient(client, sub, name);
        inserted();
        await gate; // the request is mid-flight
      }),
    );
    const outcome = write.then(() => 'committed', (error: { status?: number }) => `refused ${error.status}`);
    await insertedSignal;
    await admin((a) => a.remove({ tenantId: TENANT, sub, ...OPERATOR })); // commits immediately: the writer holds no lock on the membership yet
    release();
    expect(await outcome).toBe('refused 403');
    expect(await exists(name)).toBe(false);
  });

  it('control: the same write commits when the person is still a member', async () => {
    const { sub, version } = await newMember();
    const name = label();
    await asRequest({ sub, version }, () => database.withTenant(TENANT, (client) => insertPatient(client, sub, name)));
    expect(await exists(name)).toBe(true);
  });

  it('refuses a write admitted under a role set that has since changed', async () => {
    const { sub, version } = await newMember(['clinician']);
    const name = label();
    await admin((a) => a.setRoles({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR }));
    await expect(asRequest({ sub, version }, () => database.withTenant(TENANT, (client) => insertPatient(client, sub, name)))).rejects.toMatchObject({ status: 403 });
    expect(await exists(name)).toBe(false);
  });

  it('a removal cannot commit while a write holds the check: the write commits first, then the removal, and nothing commits after', async () => {
    const { sub, version } = await newMember();
    const name = label();
    const writer = new Client({ connectionString: db.appUrl });
    await writer.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT]);
      await insertPatient(writer, sub, name);
      expect((await writer.query('SELECT membership_assert_current($1, $2) AS ok', [sub, version])).rows[0].ok).toBe(true); // the shared lock is now held

      let removed = false;
      const removal = admin((a) => a.remove({ tenantId: TENANT, sub, ...OPERATOR })).then(() => (removed = true));
      await sleep(400);
      expect(removed).toBe(false); // the removal is waiting for the writer, not racing past it

      await writer.query('COMMIT');
      await removal;
      expect(removed).toBe(true);
      expect(await exists(name)).toBe(true); // committed before the removal did

      // Anything that checks afterwards is refused.
      await expect(asRequest({ sub, version }, () => database.withTenant(TENANT, (client) => insertPatient(client, sub, label())))).rejects.toMatchObject({ status: 403 });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
    }
  });

  it('under many interleavings, a write is either committed whole or absent, and both outcomes occur', async () => {
    const outcomes = { committed: 0, refused: 0 };
    for (let i = 0; i < 24; i++) {
      const { sub, version } = await newMember();
      const name = label();
      const writerDelay = 10;
      const removalDelay = writerDelay + (i % 2 === 0 ? -8 : 14) + (i % 5);
      const write = asRequest({ sub, version }, () =>
        database.withTenant(TENANT, async (client) => {
          await insertPatient(client, sub, name);
          await sleep(writerDelay);
        }),
      ).then(() => 'committed' as const, (error: { status?: number }) => (error.status === 403 ? ('refused' as const) : Promise.reject(error)));
      const removal = sleep(removalDelay).then(() => admin((a) => a.remove({ tenantId: TENANT, sub, ...OPERATOR })));
      const [outcome] = await Promise.all([write, removal]);
      outcomes[outcome]++;
      expect(await exists(name)).toBe(outcome === 'committed');
    }
    expect(outcomes.committed).toBeGreaterThan(0);
    expect(outcomes.refused).toBeGreaterThan(0);
  });

  it('does not lock or check a read-only transaction', async () => {
    const { sub, version } = await newMember();
    await admin((a) => a.remove({ tenantId: TENANT, sub, ...OPERATOR }));
    await expect(asRequest({ sub, version }, () => database.withTenant(TENANT, (client) => client.query('SELECT count(*) FROM patients')))).resolves.toBeDefined();
  });

  it('does not tie organization-owned work to the person whose request started it', async () => {
    const { sub, version } = await newMember();
    await admin((a) => a.remove({ tenantId: TENANT, sub, ...OPERATOR }));
    const name = label();
    await asRequest({ sub, version }, async () => {
      await asOrganizationWork(() => database.withTenant(TENANT, (client) => insertPatient(client, sub, name)));
      expect(currentRequestAuthority()).toEqual({ sub, version }); // the request's own context is untouched afterwards
    });
    expect(await exists(name)).toBe(true);
    // Not a request at all (a background job): never checked.
    await database.withTenant(TENANT, (client) => insertPatient(client, sub, label()));
  });

  it('refuses protected work when no request slot exists (misconfiguration must not fail open)', () => {
    expect(() => bindRequestAuthority({ sub: 'x', version: 1 })).toThrow(/authorityContextMiddleware/);
  });
});

describe('every kind of write a request makes passes through the commit check', () => {
  // The check is part of Database.withTenant, so these prove the route handlers, the raw-stream upload path and the ledger all reach it.
  it('is run by patient, report and upload writes and by nothing a read does', async () => {
    const app = await createTestApp({ postgresUrl: db.appUrl });
    const spy = jest.spyOn(Client.prototype, 'query');
    const checks = () => spy.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('membership_assert_current')).length;
    const delta = async (work: () => Promise<unknown>) => {
      const before = checks();
      await work();
      return checks() - before;
    };
    try {
      const t = bearer(await clinicianA());
      const api = () => request(app.getHttpServer());
      const bytes = Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');

      let patientId = '';
      expect(await delta(async () => (patientId = (await api().post('/api/v1/patients').set(t).send({ label: label() }).expect(201)).body.id))).toBeGreaterThan(0);
      expect(await delta(() => api().put(`/api/v1/patients/${patientId}`).set(t).send({ label: label() }).expect(200))).toBeGreaterThan(0);
      let reportId = '';
      expect(await delta(async () => (reportId = (await api().post('/api/v1/reports').set(t).send({ patientId, type: 'vcf', filename: 'a.vcf', sizeBytes: bytes.length }).expect(201)).body.id))).toBeGreaterThan(0);
      expect(await delta(() => api().patch(`/api/v1/reports/${reportId}`).set(t).send({ filename: 'b.vcf' }).expect(200))).toBeGreaterThan(0);

      const revision = (await api().get(`/api/v1/reports/${reportId}/upload-state`).set(t).expect(200)).body.revision;
      let attempt: { attemptId: string; revision: string } = { attemptId: '', revision: '' };
      expect(
        await delta(async () => {
          attempt = (await api().post(`/api/v1/reports/${reportId}/upload-attempts`).set(t).send({ requestId: randomUUID(), revision, contentType: 'text/x-vcf', sha256: createHash('sha256').update(bytes).digest('hex') }).expect(201)).body;
        }),
      ).toBeGreaterThan(0);
      // The raw-stream path: the bytes are read from the socket, then recorded.
      expect(
        await delta(() =>
          api().put(`/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`).set(t).set('X-Upload-Revision', attempt.revision).set('Content-Type', 'text/x-vcf').send(bytes).expect(200),
        ),
      ).toBeGreaterThan(0);

      expect(await delta(() => api().delete(`/api/v1/reports/${reportId}`).set(t).expect(204))).toBeGreaterThan(0);
      expect(await delta(() => api().delete(`/api/v1/patients/${patientId}`).set(t).expect(204))).toBeGreaterThan(0);

      // Control: reads never take the lock.
      expect(await delta(() => api().get('/api/v1/patients').set(t).expect(200))).toBe(0);
      expect(await delta(() => api().get('/api/v1/me').set(t).expect(200))).toBe(0);
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
  const label = () => `SYN-${randomUUID().slice(0, 12)}`;
});

describe('a removed person\'s transfer in flight', () => {
  it('is refused at its next write, and the organization\'s reservation for it is still released', async () => {
    const app = await createTestApp({ postgresUrl: db.appUrl });
    try {
      const t = await clinicianA();
      const api = () => request(app.getHttpServer());
      const malformed = Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\n'); // the server refuses this as a VCF once it has read it
      const patientId = (await api().post('/api/v1/patients').set(bearer(t)).send({ label: `SYN-${randomUUID().slice(0, 12)}` }).expect(201)).body.id;
      const reportId = (await api().post('/api/v1/reports').set(bearer(t)).send({ patientId, type: 'vcf', filename: 'x.vcf', sizeBytes: malformed.length }).expect(201)).body.id;
      const revision = (await api().get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(t)).expect(200)).body.revision;
      const attempt = (await api().post(`/api/v1/reports/${reportId}/upload-attempts`).set(bearer(t)).send({ requestId: randomUUID(), revision, contentType: 'text/x-vcf', sha256: createHash('sha256').update(malformed).digest('hex') }).expect(201)).body;

      // Send the first bytes, remove the person while the server is mid-transfer, then send the rest.
      const { port } = app.getHttpServer().address() as AddressInfo;
      const transfer = http.request({
        host: '127.0.0.1', port, method: 'PUT', path: `/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`,
        headers: { Authorization: `Bearer ${t}`, 'X-Upload-Revision': attempt.revision, 'Content-Type': 'text/x-vcf', 'Content-Length': malformed.length },
      });
      const status = new Promise<number>((resolve, reject) => {
        transfer.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        transfer.on('error', reject);
      });
      transfer.write(malformed.subarray(0, 10));
      await sleep(400);
      await membershipOf(app).remove({ tenantId: 'tenant-user-a', sub: 'user-a', ...OPERATOR });
      transfer.end(malformed.subarray(10));

      expect(await status).toBe(400); // the server read the rest and refused the file; nothing is accepted for a removed person
      const row = await app.get(ReportsRepository).findAttempt({ tenantId: 'tenant-user-a', reportId, id: attempt.attemptId, principal: 'user-a', revision: attempt.revision });
      expect(row?.state).toBe('cleaned'); // and the quota reservation was released anyway: that is the organization's, not the person's
    } finally {
      await app.close();
    }
  });
});

describe('the operator command', () => {
  it('grants, changes, removes and shows through the same code the tests use, and prints no secret', async () => {
    const who = person();
    const lines: string[] = [];
    const run = (args: string[]) => owner((c) => runMembership(registeringAdmin(c), args, (line) => lines.push(line)));
    const base = ['--tenant', TENANT, '--sub', who, '--by', 'ops-person', '--reason', 'new clinician'];
    expect(await run(['grant', ...base, '--roles', 'clinician,reviewer'])).toBe(0);
    expect(await run(['grant', ...base, '--roles', 'clinician'])).toBe(1); // already active
    expect(await run(['set-roles', ...base, '--roles', 'reader'])).toBe(0);
    expect(await run(['set-roles', ...base, '--roles', 'superuser'])).toBe(1);
    expect(await run(['revoke-sessions', ...base])).toBe(0);
    expect(await run(['show', '--tenant', TENANT, '--sub', who])).toBe(0);
    expect(await run(['remove', ...base])).toBe(0);
    expect(await run(['remove', ...base])).toBe(1); // no longer active
    expect(await run(['frobnicate', ...base])).toBe(1);
    expect(await run(['show', '--tenant', TENANT])).toBe(1); // --sub missing
    expect(lines.filter((l) => l.startsWith('granted')).join()).toContain('roles=clinician,reviewer version=1');
    expect(lines.some((l) => /password|postgres:\/\//i.test(l))).toBe(false);
    const row = (await owner((c) => c.query('SELECT status, roles, changed_by, reason FROM tenant_memberships WHERE sub = $1', [who]))).rows[0];
    expect(row).toEqual({ status: 'removed', roles: ['reader'], changed_by: 'ops-person', reason: 'new clinician' });
  });
});

describe('when the database cannot answer', () => {
  it('the lookup fails closed with 503, and the connection error never reaches the caller', async () => {
    const unreachable = new Database({ url: 'postgres://nobody:secret-password@127.0.0.1:1/none', ssl: 'disable' });
    try {
      const service = new MembershipService(new PostgresMembershipRepository(unreachable), new InMemorySecurityEvents());
      const error = await service.resolve({ sub: 'x', tenantId: TENANT, roles: [], issuedAt: Math.floor(Date.now() / 1000) }).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503 });
      expect(JSON.stringify((error as { response?: unknown }).response)).not.toMatch(/secret-password|127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await unreachable.onModuleDestroy();
    }
  });
});
