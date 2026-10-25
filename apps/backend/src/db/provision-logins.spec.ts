import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoUrlTls } from './tls';
import { DEFAULT_LOGINS, generatePassword, GROUP_ATTRIBUTES, loginUrl, PRIVILEGE_GROUPS, scramVerifier } from './provision-logins';

describe('scramVerifier', () => {
  it('matches an independent implementation (Python hashlib/hmac) for a fixed salt', () => {
    const verifier = scramVerifier('correct horse', Buffer.from(Array.from({ length: 16 }, (_, i) => i)), 4096);
    expect(verifier).toBe('SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$yERwYmHlx0VrpoYfOn54hMTjBUKWnmK42IDjnWgQWkk=:RQZr9F8QCYmmp35tAVzp0VB/kDwY283N+s24jDDliG4=');
  });

  it('is salted: the same password gives a different verifier each time, and never contains the password', () => {
    const a = scramVerifier('same-password');
    const b = scramVerifier('same-password');
    expect(a).not.toBe(b);
    expect(a).not.toContain('same-password');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  });
});

describe('generatePassword', () => {
  it('is 256 random bits, URL-safe (no escaping needed in a connection string or a SQL literal), and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });
});

describe('loginUrl', () => {
  it('builds a plain connection string that carries no TLS parameters and parses back to its parts', () => {
    const password = generatePassword();
    const url = loginUrl('telesphoros_api', password, { host: 'db.example.test', port: 5432 }, 'telesphoros');
    expect(() => assertNoUrlTls(url)).not.toThrow();
    const parsed = new URL(url);
    expect([parsed.protocol, parsed.username, parsed.password, parsed.hostname, parsed.port, parsed.pathname, parsed.search]).toEqual([
      'postgres:',
      'telesphoros_api',
      password,
      'db.example.test',
      '5432',
      '/telesphoros',
      '',
    ]);
  });

  it('keeps a host with a dash or a long RDS name intact', () => {
    const url = loginUrl('x', 'p', { host: 'telesphoros-staging.abc123xyz.us-east-2.rds.amazonaws.com', port: 5432 }, 'telesphoros');
    expect(new URL(url).hostname).toBe('telesphoros-staging.abc123xyz.us-east-2.rds.amazonaws.com');
  });
});

describe('the groups this command creates agree with the migrations', () => {
  const dir = join(__dirname, '../../migrations');
  const statements = readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .flatMap((f) =>
      [...readFileSync(join(dir, f), 'utf8').matchAll(/CREATE ROLE (telesphoros_[a-z_]+) ([A-Z ]+);/g)].map((m) => ({ file: f, role: m[1]!, attributes: m[2]!.trim() })),
    );

  it('finds the role statements (a floor, so an empty scan cannot pass)', () => {
    expect(statements.length).toBeGreaterThanOrEqual(5);
  });

  it('creates exactly the roles the migrations create, with exactly their attributes', () => {
    expect([...new Set(statements.map((s) => s.role))].sort()).toEqual([...PRIVILEGE_GROUPS].sort());
    for (const s of statements) expect({ role: s.role, attributes: s.attributes }).toEqual({ role: s.role, attributes: GROUP_ATTRIBUTES });
  });

  it('has five different default login names, none of them a group', () => {
    const names = Object.values(DEFAULT_LOGINS);
    expect(new Set(names).size).toBe(5);
    for (const name of names) expect((PRIVILEGE_GROUPS as readonly string[]).includes(name)).toBe(false);
  });
});
