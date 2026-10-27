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
  const url = new URL(adminUrl());
  expect(text).not.toMatch(/postgres(ql)?:\/\//);
  if (url.password) expect(text).not.toContain(decodeURIComponent(url.password));
});

it('takes no arguments', async () => {
  const { code, text } = await run(['--anything']);
  expect(code).toBe(2);
  expect(text).toContain('connection-limits');
});
