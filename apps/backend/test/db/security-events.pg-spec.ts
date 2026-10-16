import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, bindRequestAuthority, type RequestAuthority } from '../../src/auth/authority-context';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import type { MembershipAdmin } from '../../src/membership/membership';
import { PostgresSecurityEvents } from '../../src/security-events/security-events';
import { runSecurityEvents } from '../../src/security-events/security-events-cli';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registeringAdmin } from '../helpers/membership';

const TENANT = 'tenant-events-pg';
const OPERATOR = { by: 'ops-person', reason: 'a reason with spaces and an e-mail someone@example.test' };
let db: EphemeralDatabase;

beforeAll(async () => {
  db = await createEphemeralDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const person = () => `person-${randomUUID().slice(0, 8)}`;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const as = async <T>(url: string, work: (c: Client) => Promise<T>) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};
/** The application login, with an organization and a person bound to the transaction the way Database.withTenant binds them. */
const asApplication = <T>(work: (c: Client) => Promise<T>, tenant: string | null = TENANT, actor: string | null = 'person-app') =>
  as(db.appUrl, async (c) => {
    if (tenant !== null) await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenant]);
    if (actor !== null) await c.query(`SELECT set_config('app.current_actor', $1, false)`, [actor]);
    return work(c);
  });
const append = (c: Client, type: string, outcome: string, kind: string, ref: string, details: unknown, requestId: string | null = null) =>
  c.query('SELECT security_event_append($1, $2, $3, $4, $5::jsonb, $6)', [type, outcome, kind, ref, JSON.stringify(details), requestId]);
const events = (where = 'true', values: unknown[] = []) => owner(async (c) => (await c.query(`SELECT * FROM security_events WHERE ${where} ORDER BY seq`, values)).rows);

describe('the table cannot be changed, and only the auditor can read it', () => {
  it('refuses update, delete and truncate even to the owner', async () => {
    const ref = person();
    await owner(async (c) => {
      await c.query(`INSERT INTO security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref) VALUES ($1, 'access.refused', 'refused', 'system', 'x', 'person', $2)`, [TENANT, ref]);
      await expect(c.query(`UPDATE security_events SET outcome = 'succeeded' WHERE subject_ref = $1`, [ref])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`DELETE FROM security_events WHERE subject_ref = $1`, [ref])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query('TRUNCATE security_events')).rejects.toMatchObject({ code: '23000' });
    });
    expect(await events('subject_ref = $1', [ref])).toHaveLength(1);
  });

  it('gives the application login no privilege on the table and the auditor read-only', async () => {
    for (const statement of [
      'SELECT * FROM security_events',
      `INSERT INTO security_events (event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref) VALUES ('access.refused', 'refused', 'system', 'x', 'person', 'y')`,
      `UPDATE security_events SET outcome = 'succeeded'`,
      'DELETE FROM security_events',
      'TRUNCATE security_events',
    ]) {
      await expect(asApplication((c) => c.query(statement))).rejects.toMatchObject({ code: '42501' });
    }
    await as(db.auditorUrl, async (c) => {
      await expect(c.query('SELECT count(*) FROM security_events')).resolves.toBeDefined();
      for (const statement of [`INSERT INTO security_events (event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref) VALUES ('access.refused', 'refused', 'system', 'x', 'person', 'y')`, 'DELETE FROM security_events', 'SELECT * FROM tenant_memberships', 'SELECT * FROM patients']) {
        await expect(c.query(statement)).rejects.toMatchObject({ code: '42501' });
      }
    });
    // Another privileged role cannot read them either.
    await as(db.verifierUrl, async (c) => {
      await expect(c.query('SELECT count(*) FROM security_events')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('has no file-link event type at all, even for the owner', async () => {
    await expect(owner((c) => c.query(`INSERT INTO security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref) VALUES ($1, 'file.link.issued', 'succeeded', 'person', 'x', 'person', 'y')`, [TENANT]))).rejects.toMatchObject({ code: '23514' });
    await expect(owner((c) => c.query(`INSERT INTO security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref) VALUES ($1, 'access.refused', 'refused', 'person', 'x', 'report', 'y')`, [TENANT]))).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the application function callable by the application role only', async () => {
    await owner(async (c) => {
      for (const role of ['telesphoros_security_auditor', 'telesphoros_ledger_verifier', 'telesphoros_ledger_operator']) {
        expect((await c.query(`SELECT has_function_privilege($1, 'security_event_append(text,text,text,text,jsonb,text)', 'EXECUTE') AS ok`, [role])).rows[0].ok).toBe(false);
      }
      expect((await c.query(`SELECT has_function_privilege('telesphoros_app', 'security_event_append(text,text,text,text,jsonb,text)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
    });
  });
});

describe('what the application may write, and as whom', () => {
  it('records an event in the organization and for the person the transaction is bound to, and nobody else', async () => {
    const ref = randomUUID();
    await asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, { reason: 'no-membership' }, 'req-1'), 'tenant-a', 'person-a');
    const [row] = await events('subject_ref = $1', [ref]);
    expect(row).toMatchObject({ tenant_id: 'tenant-a', actor_kind: 'person', actor_ref: 'person-a', event_type: 'access.refused', outcome: 'refused', subject_kind: 'person', request_id: 'req-1', details: { reason: 'no-membership' } });
    expect(row.db_user).toBe('telesphoros_test_app');
  });

  it('refuses without an organization or a person bound, and refuses the event types it must not write', async () => {
    const ref = randomUUID();
    await expect(asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, {}), null, 'person-a')).rejects.toMatchObject({ code: '42501' });
    await expect(asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, {}), 'tenant-a', null)).rejects.toMatchObject({ code: '42501' });
    // File links are not recorded here: the application access audit records them, so the type no longer exists in this table.
    for (const type of ['membership.granted', 'membership.removed', 'membership.roles-changed', 'membership.sessions-revoked', 'membership.reinstated', 'file.link.issued']) {
      await expect(asApplication((c) => append(c, type, 'succeeded', 'person', ref, {}))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asApplication((c) => append(c, 'something.else', 'succeeded', 'person', ref, {}))).rejects.toMatchObject({ code: '42501' });
    expect(await events('subject_ref = $1', [ref])).toEqual([]);
  });

  it('refuses details that could carry a secret: unknown keys, URLs, dotted or spaced strings, long strings, nesting past the allowlist, oversize', async () => {
    const ref = randomUUID();
    const bad: unknown[] = [
      { url: 'x' }, { reason: 'https://example.test/file?X-Amz-Signature=abc' }, { reason: 'eyJhbGciOiJIUzI1NiJ9.e30.sig' }, { reason: 'has space' }, { reason: 'a'.repeat(65) },
      { reason: 'name.pdf' }, { roles: ['clinician', 'x/y'] }, { before: { nested: 'https://x.test' } }, { reason: 'ok', extra: 'no' }, { reportId: 'abc' }, { ttlSeconds: 1 }, [],
      { roles: Array.from({ length: 400 }, () => 'abcdefghij') },
    ];
    for (const details of bad) {
      await expect(asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, details))).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|22023|42501)$/) });
    }
    // Controls: values of the allowed shape are accepted.
    await asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, { reason: 'no-membership' }));
    await asApplication((c) => append(c, 'access.refused', 'refused', 'person', ref, { reason: 'removed', roles: ['reader', 'clinician'] }));
    expect(await events('subject_ref = $1', [ref])).toHaveLength(2);
  });

  it('writes one refusal per person, organization and reason per minute, and another for a different reason, person or organization', async () => {
    const who = person();
    const refuse = (reason: string, tenant = TENANT, actor = who) => asApplication((c) => append(c, 'access.refused', 'refused', 'person', actor, { reason }), tenant, actor);
    for (let i = 0; i < 10; i++) await refuse('removed');
    await refuse('token-revoked');
    await refuse('removed', 'tenant-other');
    await refuse('removed', TENANT, `${who}-2`);
    const rows = await events(`actor_ref IN ($1, $2)`, [who, `${who}-2`]);
    expect(rows.map((r) => `${r.tenant_id}/${r.actor_ref}/${r.details.reason}`)).toEqual([`${TENANT}/${who}/removed`, `${TENANT}/${who}/token-revoked`, `tenant-other/${who}/removed`, `${TENANT}/${who}-2/removed`]);
    // After the minute the same refusal is recorded again (control: the throttle is a window, not a permanent mute).
    const old = person();
    await owner((c) => c.query(`INSERT INTO security_events (occurred_at, tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (clock_timestamp() - interval '2 minutes', $1, 'access.refused', 'refused', 'person', $2, 'person', $2, '{"reason":"removed"}')`, [TENANT, old]));
    await refuse('removed', TENANT, old);
    expect(await events('actor_ref = $1', [old])).toHaveLength(2);
  });
});

describe('a refused file is recorded (0022)', () => {
  it('lets the application record an intake rejection for the bound person, throttled per type and reason, with the same detail rules as a refusal', async () => {
    const who = person();
    const reject = (reason: string, actor = who) => asApplication((c) => append(c, 'intake.rejected', 'refused', 'person', actor, { reason }), TENANT, actor);
    for (let i = 0; i < 5; i++) await reject('structure');
    await reject('checksum');
    // The same word under the other type is its own event: the throttle is per type.
    await asApplication((c) => append(c, 'access.refused', 'refused', 'person', who, { reason: 'structure' }), TENANT, who);
    const rows = await events('actor_ref = $1', [who]);
    expect(rows.map((r) => `${r.event_type}/${r.details.reason}`)).toEqual(['intake.rejected/structure', 'intake.rejected/checksum', 'access.refused/structure']);
    expect(rows.every((r) => r.tenant_id === TENANT && r.actor_kind === 'person' && r.outcome === 'refused')).toBe(true);
    // A fresh person each time, so the throttle (which answers before the table's checks) cannot be what refuses.
    for (const details of [{ filename: 'x' }, { reason: 'report.pdf' }, { reason: 'has space' }, { reason: 'a'.repeat(65) }, { reason: 'structure', sha256: 'abc' }]) {
      const fresh = person();
      await expect(asApplication((c) => append(c, 'intake.rejected', 'refused', 'person', fresh, details), TENANT, fresh)).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|22023)$/) });
    }
    await expect(asApplication((c) => append(c, 'intake.rejected', 'refused', 'person', who, { reason: 'size' }), null, who)).rejects.toMatchObject({ code: '42501' });
  });

  it('reverts only with the deliberate setting once a rejection is recorded, and then forgets the type', async () => {
    const disposable = await createEphemeralDatabase();
    try {
      const asApp = async (work: (c: Client) => Promise<unknown>) => as(disposable.appUrl, async (c) => {
        await c.query(`SELECT set_config('app.current_tenant_id', 'tenant-rev', false)`);
        await c.query(`SELECT set_config('app.current_actor', 'person-rev', false)`);
        return work(c);
      });
      await asApp((c) => append(c, 'intake.rejected', 'refused', 'person', 'person-rev', { reason: 'structure' }));
      expect(await withAdmin(disposable.adminUrl, (c) => migrateDown(c, 4))).toEqual(['0026', '0025', '0024', '0023']); // the job queue (nothing recorded) is not what is being tested
      await expect(withAdmin(disposable.adminUrl, (c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop recorded intake rejections/);
      expect((await withAdmin(disposable.adminUrl, (c) => c.query(`SELECT 1 FROM security_events WHERE event_type = 'intake.rejected'`))).rowCount).toBe(1);
      expect(await withAdmin(disposable.adminUrl, async (c) => { await c.query(`SET telesphoros.allow_audit_drop = 'yes'`); return migrateDown(c, 1); })).toEqual(['0022']);
      await expect(asApp((c) => append(c, 'intake.rejected', 'refused', 'person', 'person-rev', { reason: 'structure' }))).rejects.toMatchObject({ code: '42501' });
      await asApp((c) => append(c, 'access.refused', 'refused', 'person', 'person-rev', { reason: 'removed' })); // control: the older type still works
      expect(await withAdmin(disposable.adminUrl, (c) => migrateUp(c))).toEqual(['0022', '0023', '0024', '0025', '0026']);
      await asApp((c) => append(c, 'intake.rejected', 'refused', 'person', 'person-rev', { reason: 'structure' }));
    } finally {
      await disposable.drop();
    }
  });
});

describe('membership changes are recorded by the database, in the same transaction', () => {
  const ops = <T>(work: (a: MembershipAdmin) => Promise<T>) => owner((c) => work(registeringAdmin(c)));

  it('one event per change, in order, with the before and after roles, the operator name, and no free text', async () => {
    const who = person();
    await ops(async (a) => {
      await a.grant({ tenantId: TENANT, sub: who, roles: ['reader'], ...OPERATOR });
      await a.setRoles({ tenantId: TENANT, sub: who, roles: ['clinician', 'reviewer'], ...OPERATOR });
      await a.revokeSessions({ tenantId: TENANT, sub: who, ...OPERATOR });
      await a.remove({ tenantId: TENANT, sub: who, ...OPERATOR });
      await a.grant({ tenantId: TENANT, sub: who, roles: ['admin'], ...OPERATOR });
    });
    const rows = await events('subject_ref = $1', [who]);
    expect(rows.map((r) => [r.event_type, r.details])).toEqual([
      ['membership.granted', { after: ['reader'] }],
      ['membership.roles-changed', { before: ['reader'], after: ['clinician', 'reviewer'] }],
      ['membership.sessions-revoked', {}],
      ['membership.removed', { before: ['clinician', 'reviewer'] }],
      ['membership.reinstated', { after: ['admin'] }],
    ]);
    for (const r of rows) expect(r).toMatchObject({ tenant_id: TENANT, outcome: 'succeeded', actor_kind: 'operator', actor_ref: 'ops-person', subject_kind: 'person', db_user: expect.any(String) });
    expect(JSON.stringify(rows)).not.toMatch(/someone@example|reason with spaces/); // the free-text reason stays on the row, not in the event
  });

  it('records a change made with hand-written SQL by the owner too', async () => {
    const who = person();
    await ops((a) => a.grant({ tenantId: TENANT, sub: who, roles: ['reader'], ...OPERATOR }));
    await owner((c) => c.query(`UPDATE tenant_memberships SET roles = '{admin}', changed_by = 'dba-by-hand' WHERE sub = $1`, [who]));
    const rows = await events(`subject_ref = $1 AND event_type = 'membership.roles-changed'`, [who]);
    expect(rows).toEqual([expect.objectContaining({ actor_ref: 'dba-by-hand', details: { before: ['reader'], after: ['admin'] } })]);
  });

  it('a change with no effect records nothing, and a failed event rolls the change back', async () => {
    const who = person();
    await ops((a) => a.grant({ tenantId: TENANT, sub: who, roles: ['reader'], ...OPERATOR }));
    await owner((c) => c.query(`UPDATE tenant_memberships SET reason = 'edited' WHERE sub = $1`, [who]));
    expect(await events('subject_ref = $1', [who])).toHaveLength(1); // only the grant
    await owner(async (c) => {
      await c.query('BEGIN');
      try {
        // A constraint no event can satisfy stands in for an event store that cannot be written.
        await c.query(`ALTER TABLE security_events ADD CONSTRAINT never_satisfied CHECK (false) NOT VALID`);
        await c.query('SAVEPOINT before_removal');
        await expect(c.query(`UPDATE tenant_memberships SET status = 'removed' WHERE sub = $1`, [who])).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK TO SAVEPOINT before_removal');
        expect((await c.query(`SELECT status FROM tenant_memberships WHERE sub = $1`, [who])).rows).toEqual([{ status: 'active' }]); // no removal without its event
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect((await events('subject_ref = $1', [who])).map((r) => r.event_type)).toEqual(['membership.granted']);
  });
});

describe('the application records what happens to its callers', () => {
  const asRequest = <T>(authority: RequestAuthority, work: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      authorityContextMiddleware({ id: 'req-test' } as Request, {} as Response, () => {
        bindRequestAuthority(authority);
        work().then(resolve, reject);
      });
    });

  it('a write refused at commit because the caller was removed leaves an authority-changed refusal, with the request id', async () => {
    const database = new Database({ url: db.appUrl, ssl: 'disable' });
    new PostgresSecurityEvents(database); // wires the refusal hook
    try {
      const sub = person();
      const granted = await owner((c) => registeringAdmin(c).grant({ tenantId: TENANT, sub, roles: ['clinician'], ...OPERATOR }));
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const write = asRequest({ sub, version: granted.version }, () =>
        database.withTenant(TENANT, async (client) => {
          await client.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $2, $3)`, [TENANT, sub, `SYN-${randomUUID().slice(0, 10)}`]);
          inserted();
          await gate;
        }),
      );
      const outcome = write.then(() => 'committed', (e: { status?: number }) => `refused ${e.status}`);
      await insertedSignal;
      await owner((c) => registeringAdmin(c).remove({ tenantId: TENANT, sub, ...OPERATOR }));
      release();
      expect(await outcome).toBe('refused 403');
      const rows = await events(`actor_ref = $1 AND event_type = 'access.refused'`, [sub]);
      expect(rows).toEqual([expect.objectContaining({ tenant_id: TENANT, outcome: 'refused', details: { reason: 'authority-changed' }, request_id: 'req-test' })]);
    } finally {
      await database.onModuleDestroy();
    }
  });
});

describe('the auditor command', () => {
  it('lists an organization\'s events newest first with only the stored fields, filters them, and refuses bad input', async () => {
    const tenant = `tenant-cli-${randomUUID().slice(0, 6)}`;
    const who = person();
    await owner(async (c) => {
      const a = registeringAdmin(c);
      await a.grant({ tenantId: tenant, sub: who, roles: ['reader'], ...OPERATOR });
      await a.setRoles({ tenantId: tenant, sub: who, roles: ['clinician'], ...OPERATOR });
    });
    const lines: string[] = [];
    const run = (args: string[]) => as(db.auditorUrl, (c) => runSecurityEvents(c, args, (l) => lines.push(l)));
    expect(await run(['list', '--tenant', tenant])).toBe(0);
    const parsed = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.type)).toEqual(['membership.roles-changed', 'membership.granted']);
    expect(Object.keys(parsed[0]).sort()).toEqual(['actor', 'at', 'details', 'dbUser', 'outcome', 'requestId', 'seq', 'subject', 'tenant', 'type'].sort());
    expect(parsed[0]).toMatchObject({ tenant, actor: 'operator:ops-person', subject: `person:${who}` });
    lines.length = 0;
    expect(await run(['list', '--tenant', tenant, '--type', 'membership.granted', '--limit', '1'])).toBe(0);
    expect(lines.filter((l) => l.startsWith('{'))).toHaveLength(1);
    lines.length = 0;
    // The auditor can ask for refused files by type (the filter knows every type the table holds).
    await owner(async (c) => { await c.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenant]); await c.query(`SELECT set_config('app.current_actor', $1, false)`, [who]); await append(c, 'intake.rejected', 'refused', 'person', who, { reason: 'structure' }); });
    lines.length = 0;
    expect(await run(['list', '--tenant', tenant, '--type', 'intake.rejected'])).toBe(0);
    expect(lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((e) => [e.type, e.details])).toEqual([['intake.rejected', { reason: 'structure' }]]);
    lines.length = 0;
    expect(await run(['list', '--tenant', tenant, '--since', '2999-01-01T00:00:00Z'])).toBe(0);
    expect(lines).toEqual(['0 events']);
    for (const bad of [['list'], ['list', '--tenant', tenant, '--type', 'nope'], ['list', '--tenant', tenant, '--limit', '0'], ['list', '--tenant', tenant, '--limit', '501'], ['list', '--tenant', tenant, '--since', 'yesterday'], ['delete', '--tenant', tenant]]) {
      expect([bad, await run(bad)]).toEqual([bad, 1]);
    }
    // The application login cannot use the command at all.
    await expect(as(db.appUrl, (c) => runSecurityEvents(c, ['list', '--tenant', tenant], () => undefined))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('privacy, over everything this file recorded', () => {
  it('no stored event holds a token, a URL, a signed-link parameter, an e-mail address or a free-text reason', async () => {
    const all = await events();
    expect(all.length).toBeGreaterThan(20); // the earlier tests really recorded events
    const text = JSON.stringify(all.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'occurred_at'))));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}|https?:|X-Amz|Signature|@|someone|a reason with spaces/i);
    for (const row of all) expect(Object.keys(row.details).every((k) => ['reason', 'roles', 'before', 'after'].includes(k))).toBe(true);
  });
});
