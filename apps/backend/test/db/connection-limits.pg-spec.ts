import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { readConnectionLimits, runConnectionLimits } from '../../src/db/connection-limits';
import { adminUrl, withAdmin } from '../helpers/database';

// `connection-limits` on a real server: what it reads is what pg_settings and pg_roles hold, the budget is max_connections less every reserved
// slot, and nothing it prints is a connection string or a password.
const login = `cl_test_${randomUUID().slice(0, 8)}`;
beforeAll(() => withAdmin(adminUrl(), (c) => c.query(`CREATE ROLE ${login} LOGIN CONNECTION LIMIT 7`)));
afterAll(() => withAdmin(adminUrl(), (c) => c.query(`DROP ROLE IF EXISTS ${login}`)));

const run = (args: string[] = []) =>
  withAdmin(adminUrl(), async (c: Client) => {
    const lines: string[] = [];
    const code = await runConnectionLimits(c, args, (l) => lines.push(l));
    return { code, text: lines.join('\n') };
  });
const setting = (name: string) =>
  withAdmin(adminUrl(), (c) => c.query<{ setting: string }>('SELECT setting FROM pg_settings WHERE name = $1', [name]).then((r) => r.rows[0]?.setting));

it('reads the server limit and every reserved slot, and the budget is the limit less those slots', async () => {
  const limits = await withAdmin(adminUrl(), (c) => readConnectionLimits(c));
  expect(limits.maxConnections).toBe(Number(await setting('max_connections')));
  expect(limits.superuserReserved).toBe(Number(await setting('superuser_reserved_connections')));
  expect(limits.reserved).toBe(Number(await setting('reserved_connections'))); // PostgreSQL 16
  expect(limits.rdsReserved).toBeNull(); // not an RDS instance
  expect(limits.budget).toBe(limits.maxConnections - limits.superuserReserved - (limits.reserved ?? 0));
  expect(limits.logins).toContainEqual({ name: login, limit: 7 });
});

it('prints the reading, the budget to set and each login limit, and no connection string', async () => {
  const limits = await withAdmin(adminUrl(), (c) => readConnectionLimits(c));
  const { code, text } = await run();
  expect(code).toBe(0);
  expect(text).toContain(`max_connections: ${limits.maxConnections}`);
  expect(text).toContain('rds.rds_superuser_reserved_connections: not set');
  expect(text).toContain(`db_connection_budget = ${limits.budget}`);
  expect(text).toMatch(new RegExp(`^  ${login} +7$`, 'm'));
  expect(text).not.toMatch(/postgres(ql)?:\/\//);
});

// An allowlist of what may be printed, not "the password is not in it": CI's test password is `postgres`, which is also a role name the command
// rightly lists. Every line is a setting, a login role that pg_roles holds with its limit, or the budget; anything else (a password, a host) fails.
it('prints nothing but settings, login roles and the budget', async () => {
  const roles = await withAdmin(adminUrl(), (c) =>
    c.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolcanlogin').then((r) => new Set(r.rows.map((row) => row.rolname))),
  );
  const shapes = [
    /^max_connections: \d+$/,
    /^superuser_reserved_connections: \d+$/,
    /^reserved_connections: (\d+|not set)$/,
    /^rds\.rds_superuser_reserved_connections: (\d+|not set)$/,
    /^budget \(max_connections less the reserved slots\): -?\d+$/,
    /^login connection limits \(-1: no limit of its own\):$/,
    /^Set in Terraform from this reading: db_connection_budget = -?\d+$/,
  ];
  const { text } = await run();
  const unexpected = text.split('\n').filter((line) => {
    const role = /^ {2}(\S+) +(-?\d+)$/.exec(line);
    return role ? !roles.has(role[1]!) : !shapes.some((shape) => shape.test(line));
  });
  expect(unexpected).toEqual([]);
});

it('takes no arguments', async () => {
  const { code, text } = await run(['--anything']);
  expect(code).toBe(2);
  expect(text).toContain('connection-limits');
});
