import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/**
 * The database TLS contract against REAL TLS (FD-1, peer review of 2026-10-09). A throwaway certificate authority signs two server
 * certificates; a small TLS front speaks PostgreSQL's SSLRequest handshake and forwards the decrypted traffic to the test database. The client is
 * the application's own connection settings (src/db/tls.ts), run in a CHILD process because the trusted authorities (NODE_EXTRA_CA_CERTS) are fixed
 * when a process starts. Every refusal has a control that must succeed, so a broken front or a broken certificate cannot make the refusals pass.
 */
jest.setTimeout(90_000);

const run = promisify(execFile);
const upstream = new URL(process.env.TEST_DATABASE_URL!);
const TLS_MODULE = pathToFileURL(join(__dirname, '../../src/db/tls.ts')).href;
const PG_ENTRY = require.resolve('pg');

const CHILD = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pgClientConfig } = await import(process.env.TLS_MODULE);
const { Client } = require(process.env.PG_ENTRY);
const out = (o) => console.log('RESULT ' + JSON.stringify(o));
let client;
try {
  const settings = pgClientConfig(process.env.DB_URL, 'require');
  client = new Client({ ...settings, ...(process.env.INSECURE ? { ssl: { rejectUnauthorized: false } } : {}), connectionTimeoutMillis: 8000 });
  await client.connect();
  const encrypted = client.connection.stream.encrypted === true;
  const r = await client.query('select 1 as one');
  out({ ok: true, encrypted, one: r.rows[0].one });
} catch (e) {
  out({ ok: false, code: e.code ?? null, message: String(e.message) });
} finally {
  try { await client?.end(); } catch {}
}
`;

interface Front { port: number; sslRequests: () => number; close: () => Promise<void> }

function startTlsFront(certPem: string, keyPem: string): Promise<Front> {
  let sslRequests = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined); // intentional: a client that refuses the certificate aborts the handshake
    client.once('data', (first: Buffer) => {
      // PostgreSQL's SSLRequest: a length of 8 and the code 80877103.
      if (first.length !== 8 || first.readInt32BE(4) !== 80877103) return void client.destroy();
      sslRequests++;
      client.write('S');
      const secure = new tls.TLSSocket(client, { isServer: true, key: keyPem, cert: certPem });
      const db = net.connect(Number(upstream.port || 5432), upstream.hostname);
      const end = () => { secure.destroy(); db.destroy(); };
      secure.on('error', end); db.on('error', end); secure.on('close', end); db.on('close', end);
      secure.pipe(db); db.pipe(secure);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    sslRequests: () => sslRequests,
    close: () => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
  })));
}

let dir: string;
let caPath: string;
let goodFront: Front; // certificate valid for 127.0.0.1
let wrongNameFront: Front; // certificate from the same authority, valid only for other.example

function openssl(...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function issue(name: string, san: string): { cert: string; key: string } {
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
  return { cert: readFileSync(join(dir, `${name}.pem`), 'utf8'), key: readFileSync(join(dir, `${name}.key`), 'utf8') };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tls-contract-'));
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=telesphoros-test-authority',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  caPath = join(dir, 'ca.pem');
  const good = issue('good', 'IP:127.0.0.1');
  const wrong = issue('wrong', 'DNS:other.example');
  goodFront = await startTlsFront(good.cert, good.key);
  wrongNameFront = await startTlsFront(wrong.cert, wrong.key);
  writeFileSync(join(dir, 'child.mjs'), CHILD);
});

afterAll(async () => {
  await goodFront?.close();
  await wrongNameFront?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Outcome { ok: boolean; encrypted?: boolean; one?: number; code?: string | null; message?: string }

async function connectAsApplication(front: Front, opts: { trustAuthority: boolean; insecure?: boolean; urlQuery?: string }): Promise<Outcome> {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.hostname = '127.0.0.1';
  url.port = String(front.port);
  if (opts.urlQuery) url.search = opts.urlQuery;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TLS_MODULE, PG_ENTRY, DB_URL: url.toString() };
  if (opts.trustAuthority) env.NODE_EXTRA_CA_CERTS = caPath; // the one place the application is told which authority to trust
  if (opts.insecure) env.INSECURE = '1';
  const { stdout } = await run(process.execPath, ['--no-warnings', join(dir, 'child.mjs')], { env, timeout: 45_000 });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`the child process printed no result: ${stdout.slice(0, 300)}`);
  return JSON.parse(line.slice('RESULT '.length)) as Outcome;
}

describe('the database TLS contract against real TLS', () => {
  it('connects, encrypted, when the certificate is from a trusted authority and matches the address', async () => {
    const before = goodFront.sslRequests();
    const result = await connectAsApplication(goodFront, { trustAuthority: true });
    expect(result).toMatchObject({ ok: true, encrypted: true, one: 1 });
    expect(goodFront.sslRequests()).toBe(before + 1);
  });

  it('refuses a certificate that does not match the host name', async () => {
    const before = wrongNameFront.sslRequests();
    const result = await connectAsApplication(wrongNameFront, { trustAuthority: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(wrongNameFront.sslRequests()).toBe(before + 1); // it did reach the TLS handshake: the refusal is the certificate check
  });

  it('refuses a certificate from an authority the process does not trust', async () => {
    const before = goodFront.sslRequests();
    const result = await connectAsApplication(goodFront, { trustAuthority: false });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/certificate|self.signed|issuer/i);
    expect(result.code).not.toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(goodFront.sslRequests()).toBe(before + 1);
  });

  it('control: with verification switched off the same two connections succeed, so only verification stopped them', async () => {
    expect(await connectAsApplication(wrongNameFront, { trustAuthority: true, insecure: true })).toMatchObject({ ok: true, encrypted: true });
    expect(await connectAsApplication(goodFront, { trustAuthority: false, insecure: true })).toMatchObject({ ok: true, encrypted: true });
  });

  it.each(['sslmode=disable', 'sslmode=no-verify', 'sslmode=require', 'ssl=false'])('refuses a URL carrying %s before any connection is attempted', async (query) => {
    const before = goodFront.sslRequests();
    const result = await connectAsApplication(goodFront, { trustAuthority: true, urlQuery: query });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/must not carry TLS parameters/);
    expect(goodFront.sslRequests()).toBe(before); // nothing reached the front
  });
});
