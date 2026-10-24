import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, membershipOf, tenantsOf, usingPostgres } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

/**
 * Member administration (M2.1a, decisions DP-1 and DP-2). The apps run WITHOUT the helper that mirrors token claims, so every person exists
 * because the test granted them; the same file runs in memory and on PostgreSQL, where the rules live in SECURITY DEFINER functions.
 */
const OPERATOR = { by: 'operator-test', reason: 'test' };
let app: NestExpressApplication;
const api = () => request(app.getHttpServer());
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
const as = async (tenant: string, sub: string) => bearer(await signToken({ sub, tenant }));

/** A fresh organization with one administrator, so tests never share the "last administrator" state. */
type RoleName = 'reader' | 'clinician' | 'admin' | 'reviewer';
async function organization(): Promise<{ tenant: string; admin: string }> {
  const tenant = id('org');
  const admin = id('admin');
  await tenantsOf(app).registerTenant({ id: tenant, displayName: `Clinic ${tenant}`, by: 'operator-test' });
  await membershipOf(app).grant({ tenantId: tenant, sub: admin, roles: ['admin'], ...OPERATOR });
  return { tenant, admin };
}
async function person(tenant: string, roles: RoleName[]): Promise<string> {
  const sub = id('person');
  await membershipOf(app).grant({ tenantId: tenant, sub, roles, ...OPERATOR });
  return sub;
}
const listed = async (tenant: string, admin: string) => (await api().get('/api/v1/members').set(await as(tenant, admin)).expect(200)).body.data as Array<{ sub: string; roles: string[] }>;

beforeAll(async () => {
  app = await createTestApp({ membershipFromTokens: false });
});
afterAll(async () => {
  await app.close();
});

describe('who may administer members', () => {
  it('an administrator sees the people of their own organization and only theirs', async () => {
    const a = await organization();
    const b = await organization();
    const colleague = await person(a.tenant, ['clinician']);
    const elsewhere = await person(b.tenant, ['reader']);
    const seen = (await listed(a.tenant, a.admin)).map((m) => m.sub);
    expect(seen).toEqual(expect.arrayContaining([a.admin, colleague]));
    expect(seen).not.toContain(elsewhere);
    expect(seen).not.toContain(b.admin);
  });

  it.each([[['reader']], [['clinician']], [['reviewer']], [['clinician', 'reviewer']]] as RoleName[][][])('a member holding only %j is refused every members route (403)', async (roles) => {
    const { tenant } = await organization();
    const someone = await person(tenant, roles);
    const headers = await as(tenant, someone);
    const target = await person(tenant, ['reader']);
    const attempts = [
      api().get('/api/v1/members').set(headers),
      api().put(`/api/v1/members/${target}/roles`).set(headers).send({ roles: ['admin'] }),
      api().delete(`/api/v1/members/${target}`).set(headers),
      api().post('/api/v1/members/invitations').set(headers).send({ email: 'x@example.test', roles: ['reader'] }),
      api().get('/api/v1/members/invitations').set(headers),
      api().delete(`/api/v1/members/invitations/${randomUUID()}`).set(headers),
    ];
    for (const res of await Promise.all(attempts)) expect([res.status, res.body.error?.code]).toEqual([403, 'FORBIDDEN']);
    // Nothing changed: the target still holds exactly what they held.
    const admin = await person(tenant, ['admin']);
    expect((await listed(tenant, admin)).find((m) => m.sub === target)?.roles).toEqual(['reader']);
  });

  it('administration is not clinical: an administrator is refused patients and reports, and the ledger check stays theirs', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    for (const path of ['/api/v1/patients', '/api/v1/reports']) expect((await api().get(path).set(headers)).status).toBe(403);
    expect((await api().post('/api/v1/patients').set(headers).send({ label: 'SYN-ADMIN' })).status).toBe(403);
    // A person who needs both holds both roles (control).
    const both = await person(tenant, ['admin', 'clinician']);
    expect((await api().get('/api/v1/patients').set(await as(tenant, both))).status).toBe(200);
    expect((await api().get('/api/v1/members').set(await as(tenant, both))).status).toBe(200);
  });
});

describe('changing roles and removing people', () => {
  it('changes a colleague\'s roles, and the change is felt on their very next request', async () => {
    const { tenant, admin } = await organization();
    const colleague = await person(tenant, ['reader']);
    const theirs = await as(tenant, colleague);
    expect((await api().post('/api/v1/patients').set(theirs).send({ label: 'SYN-BEFORE' })).status).toBe(403);
    await api().put(`/api/v1/members/${colleague}/roles`).set(await as(tenant, admin)).send({ roles: ['clinician'] }).expect(204);
    expect((await api().post('/api/v1/patients').set(theirs).send({ label: 'SYN-AFTER' })).status).toBe(201);
    expect((await listed(tenant, admin)).find((m) => m.sub === colleague)?.roles).toEqual(['clinician']);
  });

  it('removes a colleague, who is then refused immediately', async () => {
    const { tenant, admin } = await organization();
    const colleague = await person(tenant, ['clinician']);
    expect((await api().get('/api/v1/patients').set(await as(tenant, colleague))).status).toBe(200);
    await api().get('/api/v1/me/recovery-scope').set(await as(tenant, colleague)).expect(200);
    await api().delete(`/api/v1/members/${colleague}`).set(await as(tenant, admin)).expect(204);
    expect((await api().get('/api/v1/patients').set(await as(tenant, colleague))).status).toBe(403);
    await api().get('/api/v1/me/recovery-scope').set(await as(tenant, colleague)).expect(403);
    expect((await listed(tenant, admin)).map((m) => m.sub)).not.toContain(colleague);
  });

  it('never changes or removes the caller: another administrator must (409 member-self)', async () => {
    const { tenant, admin } = await organization();
    const second = await person(tenant, ['admin']);
    for (const res of [
      await api().put(`/api/v1/members/${admin}/roles`).set(await as(tenant, admin)).send({ roles: ['reader'] }),
      await api().delete(`/api/v1/members/${admin}`).set(await as(tenant, admin)),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.details[0].reason).toBe('member-self');
    }
    // The control: the other administrator can do the same to them.
    await api().put(`/api/v1/members/${admin}/roles`).set(await as(tenant, second)).send({ roles: ['reader'] }).expect(204);
  });

  it('an organization always keeps an administrator: two administrators demoting each other at the same moment leave exactly one', async () => {
    const { tenant, admin } = await organization();
    const second = await person(tenant, ['admin']);
    const [one, two] = await Promise.all([
      api().put(`/api/v1/members/${second}/roles`).set(await as(tenant, admin)).send({ roles: ['reader'] }),
      api().put(`/api/v1/members/${admin}/roles`).set(await as(tenant, second)).send({ roles: ['reader'] }),
    ]);
    // Whoever is first wins. The other is refused: 409 last-administrator if it passed the administrator check before the winner committed (the rule after
    // the per-organization lock catches it), 403 if it arrived afterwards. Never both succeed, and never neither.
    const statuses = [one.status, two.status].sort();
    expect(statuses[0]).toBe(204);
    expect([403, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) expect([one, two].find((r) => r.status === 409)!.body.error.details[0].reason).toBe('last-administrator');
    const remaining = await api().get('/api/v1/members').set(await as(tenant, one.status === 204 ? admin : second));
    expect(remaining.status).toBe(200);
    expect(remaining.body.data.filter((m: { roles: string[] }) => m.roles.includes('admin'))).toHaveLength(1);
  });

  it('a person demoted from administrator cannot go on administering (403), and the remaining administrator is untouched', async () => {
    const { tenant, admin } = await organization();
    const second = await person(tenant, ['admin']);
    await api().put(`/api/v1/members/${second}/roles`).set(await as(tenant, admin)).send({ roles: ['clinician'] }).expect(204);
    expect((await api().put(`/api/v1/members/${admin}/roles`).set(await as(tenant, second)).send({ roles: ['reader'] })).status).toBe(403);
    expect((await listed(tenant, admin)).find((m) => m.sub === admin)?.roles).toEqual(['admin']);
  });

  it('cannot reach another organization\'s people, and does not reveal whether they exist (404)', async () => {
    const a = await organization();
    const b = await organization();
    const victim = await person(b.tenant, ['clinician']);
    const headers = await as(a.tenant, a.admin);
    const change = await api().put(`/api/v1/members/${victim}/roles`).set(headers).send({ roles: ['reader'] });
    const remove = await api().delete(`/api/v1/members/${victim}`).set(headers);
    const missing = await api().delete(`/api/v1/members/${id('nobody')}`).set(headers);
    for (const res of [change, remove, missing]) expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect({ ...change.body.error, requestId: undefined }).toEqual({ ...missing.body.error, requestId: undefined }); // the same answer for a real person elsewhere and for nobody
    // Untouched.
    expect((await listed(b.tenant, b.admin)).find((m) => m.sub === victim)?.roles).toEqual(['clinician']);
  });

  it('refuses unknown roles and malformed input (400) and changes nothing; an empty set is allowed (a member with no role can sign in and nothing else)', async () => {
    const { tenant, admin } = await organization();
    const colleague = await person(tenant, ['reader']);
    const headers = await as(tenant, admin);
    for (const roles of [['superuser'], 'admin', undefined, ['reader', 1]]) {
      expect((await api().put(`/api/v1/members/${colleague}/roles`).set(headers).send({ roles })).status).toBe(400);
    }
    expect((await api().put(`/api/v1/members/${colleague}/roles`).set(headers).send({ roles: ['reader'], extra: 1 })).status).toBe(400);
    expect((await listed(tenant, admin)).find((m) => m.sub === colleague)?.roles).toEqual(['reader']);
    await api().put(`/api/v1/members/${colleague}/roles`).set(headers).send({ roles: [] }).expect(204);
    expect((await listed(tenant, admin)).find((m) => m.sub === colleague)?.roles).toEqual([]);
    expect((await api().get('/api/v1/me').set(await as(tenant, colleague))).body).toEqual({ roles: [] });
  });
});

describe('a suspended organization', () => {
  it('is refused everywhere, administrators included, until it is reactivated', async () => {
    const { tenant, admin } = await organization();
    const clinician = await person(tenant, ['clinician']);
    expect((await api().get('/api/v1/patients').set(await as(tenant, clinician))).status).toBe(200);
    await tenantsOf(app).setTenantStatus({ id: tenant, status: 'suspended', by: 'operator-test' });
    for (const who of [clinician, admin]) {
      expect((await api().get('/api/v1/me').set(await as(tenant, who))).status).toBe(403);
    }
    expect((await api().get('/api/v1/members').set(await as(tenant, admin))).status).toBe(403);
    await tenantsOf(app).setTenantStatus({ id: tenant, status: 'active', by: 'operator-test' });
    expect((await api().get('/api/v1/patients').set(await as(tenant, clinician))).status).toBe(200);
  });
});

describe('invitations are a record, never an account', () => {
  it('creates, lists and cancels an invitation, showing only a masked hint of the address', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    const email = `new.person.${randomUUID().slice(0, 6)}@example.test`;
    const created = await api().post('/api/v1/members/invitations').set(headers).send({ email: email.toUpperCase(), roles: ['clinician', 'reviewer'] }).expect(201);
    expect(created.body).toMatchObject({ status: 'pending', roles: ['clinician', 'reviewer'] });
    expect(JSON.stringify(created.body)).not.toContain(email);
    expect(created.body.emailHint).toBe('n***@example.test'); // a masked hint, not the address
    const list = await api().get('/api/v1/members/invitations').set(headers).expect(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(created.body.id);
    expect(JSON.stringify(list.body)).not.toContain(email);
    await api().delete(`/api/v1/members/invitations/${created.body.id}`).set(headers).expect(204);
    const after = await api().get('/api/v1/members/invitations').set(headers).expect(200);
    expect(after.body.data.find((i: { id: string }) => i.id === created.body.id)?.status).toBe('cancelled');
    // An invitation is not a member: it grants nothing and creates no account.
    expect((await listed(tenant, admin)).map((m) => m.sub)).toEqual([admin]);
  });

  it('refuses a second pending invitation for the same address, whatever the letter case (409 invitation-pending), and allows it again after cancelling', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    const email = `dup.${randomUUID().slice(0, 6)}@example.test`;
    const first = await api().post('/api/v1/members/invitations').set(headers).send({ email, roles: ['reader'] }).expect(201);
    const again = await api().post('/api/v1/members/invitations').set(headers).send({ email: email.toUpperCase(), roles: ['reader'] });
    expect([again.status, again.body.error.details[0].reason]).toEqual([409, 'invitation-pending']);
    await api().delete(`/api/v1/members/invitations/${first.body.id}`).set(headers).expect(204);
    await api().post('/api/v1/members/invitations').set(headers).send({ email, roles: ['reader'] }).expect(201);
  });

  it('is scoped to the organization: another organization cannot see or cancel it, and the same address may be invited by both', async () => {
    const a = await organization();
    const b = await organization();
    const email = `shared.${randomUUID().slice(0, 6)}@example.test`;
    const mine = await api().post('/api/v1/members/invitations').set(await as(a.tenant, a.admin)).send({ email, roles: ['reader'] }).expect(201);
    expect((await api().get('/api/v1/members/invitations').set(await as(b.tenant, b.admin)).expect(200)).body.data).toEqual([]);
    expect((await api().delete(`/api/v1/members/invitations/${mine.body.id}`).set(await as(b.tenant, b.admin))).status).toBe(404);
    await api().post('/api/v1/members/invitations').set(await as(b.tenant, b.admin)).send({ email, roles: ['reader'] }).expect(201);
    expect((await api().get('/api/v1/members/invitations').set(await as(a.tenant, a.admin)).expect(200)).body.data[0].status).toBe('pending');
  });

  it('is limited to 100 pending invitations per organization (409 invitation-limit)', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    const mint = (n: number) => api().post('/api/v1/members/invitations').set(headers).send({ email: `bulk.${n}@example.test`, roles: ['reader'] });
    for (let batch = 0; batch < 100; batch += 20) await Promise.all(Array.from({ length: 20 }, (_, i) => mint(batch + i).then((res) => expect(res.status).toBe(201))));
    const over = await mint(100);
    expect([over.status, over.body.error.details[0].reason]).toEqual([409, 'invitation-limit']);
  }, 60_000);

  it('refuses a malformed address, a role that does not exist and a missing field (400)', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    for (const body of [{ email: 'not-an-address', roles: ['reader'] }, { email: 'a@example.test', roles: ['superuser'] }, { email: 'a@example.test' }, { roles: ['reader'] }]) {
      expect((await api().post('/api/v1/members/invitations').set(headers).send(body)).status).toBe(400);
    }
  });

  it('cancelling an invitation that is not there, or already cancelled, answers 404', async () => {
    const { tenant, admin } = await organization();
    const headers = await as(tenant, admin);
    expect((await api().delete(`/api/v1/members/invitations/${randomUUID()}`).set(headers)).status).toBe(404);
    const made = await api().post('/api/v1/members/invitations').set(headers).send({ email: `once.${randomUUID().slice(0, 6)}@example.test`, roles: ['reader'] }).expect(201);
    await api().delete(`/api/v1/members/invitations/${made.body.id}`).set(headers).expect(204);
    expect((await api().delete(`/api/v1/members/invitations/${made.body.id}`).set(headers)).status).toBe(404);
  });
});

it(`ran against ${usingPostgres() ? 'PostgreSQL (functions, RLS)' : 'the in-memory store'}`, () => {
  expect(typeof usingPostgres()).toBe('boolean');
});
