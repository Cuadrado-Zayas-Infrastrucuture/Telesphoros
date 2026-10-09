import { loadEnv } from '../config/env';
import { pgEnv } from './pg-process';
import { assertNoUrlTls, pgClientConfig, tlsFromEnv, urlTlsParameters } from './tls';

const CLEAN = 'postgres://app_login:s3cret-pass@db.internal:5432/telesphoros';

describe('the database TLS contract', () => {
  describe('URL parameters', () => {
    it.each([
      ['sslmode=require'],
      ['sslmode=verify-full'],
      ['sslmode=disable'],
      ['sslmode=no-verify'],
      ['ssl=true'],
      ['sslrootcert=/tmp/x.pem'],
      ['sslcert=/tmp/c.pem&sslkey=/tmp/k.pem'],
      ['uselibpqcompat=true&sslmode=require'],
      ['SSLMODE=disable'],
      ['application_name=x&SslMode=require'],
    ])('refuses %s', (query) => {
      const url = `${CLEAN}?${query}`;
      expect(urlTlsParameters(url).length).toBeGreaterThan(0);
      expect(() => assertNoUrlTls(url)).toThrow(/TLS parameters/);
      expect(() => pgClientConfig(url, 'require')).toThrow(/TLS parameters/);
      expect(() => pgEnv(url, undefined, 'require', { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' })).toThrow(/TLS parameters/);
    });

    it('control: a URL with other parameters, or none, is accepted', () => {
      for (const url of [CLEAN, `${CLEAN}?application_name=x`, `${CLEAN}?connect_timeout=5&options=-c%20role%3Dx`]) {
        expect(urlTlsParameters(url)).toEqual([]);
        expect(() => assertNoUrlTls(url)).not.toThrow();
        expect(() => pgClientConfig(url, 'require')).not.toThrow();
      }
    });

    it('names the parameters but never quotes the URL, its password or its values', () => {
      const url = 'postgres://app_login:hunter2-very-secret@db.internal:5432/telesphoros?sslmode=disable&sslrootcert=/secret/path.pem';
      for (const act of [() => assertNoUrlTls(url), () => pgClientConfig(url), () => pgEnv(url)]) {
        let message = '';
        try {
          act();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/sslmode, sslrootcert/);
        expect(message).not.toContain('hunter2');
        expect(message).not.toContain('db.internal');
        expect(message).not.toContain('/secret/path.pem');
        expect(message).not.toContain('disable&');
      }
    });

    it('does not quote an unreadable URL either', () => {
      let message = '';
      try {
        urlTlsParameters('not a url hunter2');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/could not be read/);
      expect(message).not.toContain('hunter2');
    });
  });

  describe('the explicit setting', () => {
    it('is always explicit, so the PGSSLMODE environment variable is never consulted', () => {
      expect(pgClientConfig(CLEAN, 'disable').ssl).toBe(false);
      expect(pgClientConfig(CLEAN, 'require').ssl).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    });

    it('is read from DATABASE_SSL: absent means disable; only disable and require are accepted', () => {
      expect(tlsFromEnv({})).toBe('disable');
      expect(tlsFromEnv({ DATABASE_SSL: '' })).toBe('disable');
      expect(tlsFromEnv({ DATABASE_SSL: 'disable' })).toBe('disable');
      expect(tlsFromEnv({ DATABASE_SSL: 'require' })).toBe('require');
      for (const bad of ['verify-full', 'REQUIRE', 'true', 'no-verify', 'prefer']) {
        expect(() => tlsFromEnv({ DATABASE_SSL: bad })).toThrow(/DATABASE_SSL must be/);
      }
    });
  });

  describe('the command-line tools (libpq)', () => {
    it('require means verify-full against the named authority file, with TLS 1.2 or newer', () => {
      const env = pgEnv(CLEAN, 'other', 'require', { DATABASE_SSL_CA: '/etc/rds-ca.pem', NODE_EXTRA_CA_CERTS: '/etc/other.pem' });
      expect(env).toMatchObject({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/etc/rds-ca.pem', PGSSLMINPROTOCOLVERSION: 'TLSv1.2', PGDATABASE: 'other', PGHOST: 'db.internal' });
    });

    it('falls back to NODE_EXTRA_CA_CERTS, and refuses rather than connecting unverified when there is no authority file', () => {
      expect(pgEnv(CLEAN, undefined, 'require', { NODE_EXTRA_CA_CERTS: '/etc/ca.pem' }).PGSSLROOTCERT).toBe('/etc/ca.pem');
      expect(() => pgEnv(CLEAN, undefined, 'require', {})).toThrow(/certificate authority file/);
    });

    it('disable is explicit, and nothing is inherited from the surrounding environment', () => {
      const env = pgEnv(CLEAN, undefined, 'disable', { PGSSLMODE: 'require', DATABASE_SSL_CA: '/x' });
      expect(env.PGSSLMODE).toBe('disable');
      expect(env.PGSSLROOTCERT).toBeUndefined();
    });
  });

  describe('start-up validation and the connection builder refuse the same names', () => {
    const base = { NODE_ENV: 'development', STORAGE_DRIVER: 'postgres' } as const;
    const cases = ['sslmode=disable', 'sslmode=require', 'ssl=true', 'sslrootcert=/x', 'uselibpqcompat=true', 'SSLMODE=no-verify', 'application_name=x', 'connect_timeout=3'];

    it.each(cases)('agree on %s', (query) => {
      const url = `${CLEAN}?${query}`;
      const refusedByBuilder = urlTlsParameters(url).length > 0;
      let refusedByEnv = false;
      try {
        loadEnv({ ...base, DATABASE_URL: url });
      } catch (error) {
        refusedByEnv = /TLS parameters/.test((error as Error).message);
      }
      expect(refusedByEnv).toBe(refusedByBuilder);
      let verifierRefused = false;
      try {
        loadEnv({ ...base, DATABASE_URL: CLEAN, LEDGER_VERIFIER_DATABASE_URL: url });
      } catch (error) {
        verifierRefused = /LEDGER_VERIFIER_DATABASE_URL.*TLS parameters/.test((error as Error).message);
      }
      expect(verifierRefused).toBe(refusedByBuilder);
    });
  });
});
