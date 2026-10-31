import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { createBackup } from '../src/db/backup';
import { pinoHttpOptions } from '../src/logger-options';
import { FIELD_KEY_PROVIDER, type FieldKeyProvider, LocalFieldKeyProvider } from '../src/patient-demographics/field-key-provider';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 025 PD-1 (T104) and PD-2: no identity value is stored, logged, returned in an error or written to a backup in plaintext. The test seeds recognizable
// synthetic values and then SEARCHES: every column of every public table, the captured log lines, the error bodies of invalid requests that echo the values,
// the security-event rows, and the plaintext dump the backup command makes before it encrypts. Each search has a positive control in the same run, so a scan
// that cannot see anything cannot pass. Synthetic data only: every value here is invented.
const GIVEN = 'Zzyzx-Pdone-Given';
const FAMILY = 'Qwxyz-Pdone-Family';
const DOB = '1962-07-19';
/** Values that must not appear anywhere. The year alone is a coded column on purpose (D1), so it is not here; the full date and the two names are. */
const SECRETS = [GIVEN, FAMILY, DOB, 'Zzyzx', 'Qwxyz', '1962-07-19', '19620719', '07/19/1962', 'July 19, 1962'];
/** Every way a stored byte string can show a value: the text, its hex (how a bytea column prints), its base64, and its percent-encoding. */
const forms = (value: string): string[] => {
  const bytes = Buffer.from(value, 'utf8');
  return [value, value.toLowerCase(), bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url'), encodeURIComponent(value)];
};
const needles = SECRETS.flatMap(forms);
const findIn = (text: string): string[] => needles.filter((needle) => text.includes(needle) || text.toLowerCase().includes(needle.toLowerCase()));

class SwitchableProvider implements FieldKeyProvider {
  readonly id = 'local' as const;
  fail = false;
  private readonly inner = new LocalFieldKeyProvider();
  async generateDataKey(context: { tenant: string; patient: string }) {
    if (this.fail) throw new Error(`synthetic outage ${GIVEN}`); // a provider error that carries a value: it must not reach a log or a response
    return this.inner.generateDataKey(context);
  }
  async unwrap(wrapped: Buffer, context: { tenant: string; patient: string }) {
    return this.inner.unwrap(wrapped, context);
  }
}

(usingPostgres() ? describe : describe.skip)('patient demographics: no plaintext identity anywhere (PD-1, PD-2)', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  const provider = new SwitchableProvider();
  const logged: string[] = [];
  const scratch: string[] = [];

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logged.push(chunk.toString());
        done();
      },
    });
    app = await createTestApp({
      postgresUrl: db.appUrl,
      overrides: [
        { provide: FIELD_KEY_PROVIDER, useValue: provider },
        // The REAL log configuration (field allowlist, serializers), at the most verbose level, writing to a buffer we can read.
        { provide: 'pino-params', useValue: { pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'trace' }), sink] } },
      ],
    });
    app.useLogger(app.get(Logger)); // Nest's own Logger (the demographics service uses one) goes through pino too
    lab = new LabPipeline(app, db.adminUrl);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await db.drop();
    scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  const body = (over: object = {}) => ({ givenName: GIVEN, familyName: FAMILY, dateOfBirth: DOB, sex: 'male', ethnicity: ['white'], ...over });

  /** The traffic a careless implementation would leak from: a success, a read, a correction, a retry, invalid requests that echo the values, a provider outage, an erased read. */
  async function seedAndDrive() {
    const clinician = await lab.person('dr', ['clinician']);
    const patientId = await lab.patient(clinician);
    const api = (m: 'get' | 'post', path: string, who = clinician) => lab.api()[m](`/api/v1/patients/${patientId}/demographics${path}`).set(bearer(who.token));
    const responses: string[] = [];
    const record = (res: { status: number; text: string }) => responses.push(`${res.status} ${res.text}`);

    record(
      await api('post', '')
        .send(body({ requestId: randomUUID() }))
        .expect(201),
    );
    record(await api('get', '').expect(200));
    record(
      await api('post', '')
        .send(body({ familyName: `${FAMILY}-corrected` }))
        .expect(201),
    );
    record(await api('get', '?version=1').expect(200));
    // Invalid requests that carry the values: a date that is wrong around a real value, unknown keys named after a value, a bad code, a wrong type.
    record(
      await api('post', '')
        .send(body({ dateOfBirth: `${DOB}-${GIVEN}` }))
        .expect(400),
    );
    record(
      await api('post', '')
        .send(body({ dateOfBirth: '1962-07-99' }))
        .expect(400),
    );
    record(
      await api('post', '')
        .send({ ...body(), [GIVEN]: FAMILY })
        .expect(400),
    );
    record(
      await api('post', '')
        .send(body({ sex: GIVEN, ethnicity: [FAMILY] }))
        .expect(400),
    );
    record(
      await api('post', '')
        .send(body({ givenName: { nested: GIVEN }, familyName: [FAMILY] }))
        .expect(400),
    );
    record(
      await api('post', '')
        .send(body({ requestId: GIVEN }))
        .expect(400),
    );
    record(await api('get', `?version=${GIVEN}`).expect(400));
    record(await lab.api().get(`/api/v1/patients/${GIVEN}/demographics`).set(bearer(clinician.token)).expect(400));
    // Refused by role, and for another organization.
    const admin = await lab.person('admin', ['admin']);
    record(await api('get', '', admin).expect(403));
    record(await api('post', '', admin).send(body()).expect(403));
    const stranger = await lab.person('stranger', ['clinician'], `tenant-${randomUUID().slice(0, 8)}`);
    record(await api('post', '', stranger).send(body()).expect(404));
    // A provider outage whose own message carries a value.
    const second = await lab.patient(clinician);
    provider.fail = true;
    record(await lab.api().post(`/api/v1/patients/${second}/demographics`).set(bearer(clinician.token)).send(body()).expect(503));
    provider.fail = false;
    // An erased identity.
    await withAdmin(db.adminUrl, (c) => c.query('SELECT patient_field_key_erase($1, $2)', [lab.tenant, patientId]));
    record(await api('get', '').expect(410));
    record(await api('post', '').send(body()).expect(410));
    return { patientId, responses };
  }

  let driven: Awaited<ReturnType<typeof seedAndDrive>>;
  beforeAll(async () => {
    driven = await seedAndDrive();
  }, 60_000);

  it('control: the traffic really stored identity and really produced the log lines and responses the searches below look at', async () => {
    expect(await lab.count('patient_demographics', 'patient_id = $1', [driven.patientId])).toBe(2);
    expect(driven.responses.length).toBeGreaterThan(15);
    const lines = logged.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.some((l) => l.includes('/api/v1/patients/:id/demographics'))).toBe(true); // the route template of the demographics routes was logged
    expect(lines.some((l) => l.includes('patient-key-error'))).toBe(true); // and so was the provider outage (without its message)
  });

  // (1) the database
  it('no column of any table, as the administrator sees it, holds a name or the date of birth: as text, as hex, as base64 or percent-encoded', async () => {
    const tables = (await lab.row<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.tablename);
    expect(tables).toEqual(expect.arrayContaining(['patient_demographics', 'patient_field_keys', 'patients', 'security_events', 'security_audit_events', 'ledger_events']));
    const found: string[] = [];
    let rowsScanned = 0;
    for (const table of tables) {
      // The whole row as text (a bytea prints as hex), and every column of it: a value in any column, of any type, is in this text.
      const rows = await lab.row<{ t: string }>(`SELECT t::text AS t FROM public."${table}" t`);
      rowsScanned += rows.length;
      for (const row of rows) for (const hit of findIn(row.t)) found.push(`${table}: ${hit.slice(0, 12)}`);
    }
    expect(found).toEqual([]);
    expect(rowsScanned).toBeGreaterThan(30); // the scan read a database with content in it
  });

  it('control for the scan: it does see a plaintext value in a column, and does see bytes in a bytea column as hex', async () => {
    const [{ label }] = await lab.row<{ label: string }>('SELECT label FROM patients WHERE id = $1', [driven.patientId]);
    const patientRows = await lab.row<{ t: string }>('SELECT t::text AS t FROM public.patients t WHERE id = $1', [driven.patientId]);
    expect(patientRows[0]!.t).toContain(label);
    const [{ hex }] = await lab.row<{ hex: string }>(`SELECT encode(given_name_ct, 'hex') AS hex FROM patient_demographics WHERE patient_id = $1 AND version = 1`, [
      driven.patientId,
    ]);
    const demographics = await lab.row<{ t: string }>('SELECT t::text AS t FROM public.patient_demographics t WHERE patient_id = $1 AND version = 1', [driven.patientId]);
    expect(demographics[0]!.t).toContain(hex);
    // And the matcher itself: it finds each form of a planted value.
    for (const form of forms(GIVEN)) expect(findIn(`before ${form} after`).length).toBeGreaterThan(0);
  });

  it('keeps a digest of each ciphertext in the ledger projection, and not one needle in any ledger event or projection', async () => {
    const events = await lab.row<{ t: string }>(`SELECT e::text AS t FROM ledger_events e WHERE tenant_id = $1 AND event_type = 'patient-demographics'`, [lab.tenant]);
    expect(events).toHaveLength(2);
    for (const e of events) expect(findIn(e.t)).toEqual([]);
  });

  // (2) the logs
  it('no log line holds a name, a date of birth, or a ciphertext', () => {
    const raw = logged.join('');
    expect(findIn(raw)).toEqual([]);
    // The unparsed stream is checked as well as each line, so a value split across a JSON string cannot hide.
    for (const line of raw.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('nothing from the provider outage (its message carried a value) reached a log line', () => {
    const outage = logged
      .join('')
      .split('\n')
      .filter((l) => l.includes('patient-key-error'));
    expect(outage.length).toBeGreaterThan(0);
    for (const line of outage) {
      expect(line).not.toContain('synthetic outage');
      expect(findIn(line)).toEqual([]);
    }
  });

  // (3) the responses: success bodies hold the values for a clinical reader, error bodies never do
  it('no error body, however invalid the request, repeats a submitted value; success bodies are the only responses that carry identity', () => {
    const errors = driven.responses.filter((r) => !/^20[01] /.test(r));
    expect(errors.length).toBeGreaterThan(12);
    for (const response of errors) expect({ status: response.slice(0, 3), hits: findIn(response) }).toEqual({ status: response.slice(0, 3), hits: [] });
    const successes = driven.responses.filter((r) => /^20[01] /.test(r));
    expect(successes.length).toBe(4);
    expect(successes.some((r) => r.includes(GIVEN))).toBe(true); // control: a success body for a clinical role does carry the identity, so the error check above is not vacuous
  });

  // (4) the security events and the access evidence
  it('no security event or access-evidence row holds a value, and the demographics routes left their evidence (route and patient id only)', async () => {
    const events = await lab.row<{ t: string }>(`SELECT t::text AS t FROM security_events t`);
    const audit = await lab.row<{ t: string; route_key: string; subject_id: string | null }>(
      `SELECT t::text AS t, route_key, subject_id::text AS subject_id FROM security_audit_events t`,
    );
    for (const row of [...events, ...audit]) expect(findIn(row.t)).toEqual([]);
    const mine = audit.filter((r) => r.route_key.startsWith('PatientDemographicsController.'));
    expect(mine.length).toBeGreaterThan(5); // control: the routes were audited
    expect(mine.every((r) => r.subject_id === null || /^[0-9a-f-]{36}$/.test(r.subject_id))).toBe(true);
  });

  // (5) the backup
  it('the backup command’s plaintext dump holds no value: only ciphertext, in the database’s own text form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd1-backup-'));
    scratch.push(dir);
    const { dir: backupDir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: dir }); // no key file: the dump the encrypted backup would encrypt is left in place
    expect(manifest.dump.encrypted).toBe(false);
    expect(manifest.tables.patient_demographics!.rows).toBeGreaterThanOrEqual(2);
    const sql = execFileSync('pg_restore', ['--file=-', join(backupDir, 'db.dump')], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
    const raw = readFileSync(join(backupDir, 'db.dump')).toString('latin1');
    expect(sql).toContain('COPY public.patient_demographics'); // control: the dump has the table's rows, as text
    const [{ hex }] = await lab.row<{ hex: string }>(`SELECT encode(given_name_ct, 'hex') AS hex FROM patient_demographics WHERE patient_id = $1 AND version = 1`, [
      driven.patientId,
    ]);
    expect(sql).toContain(hex); // control: the ciphertext is in the dump, as bytea hex
    expect(findIn(sql)).toEqual([]);
    expect(findIn(raw)).toEqual([]); // and in the file itself, in case of compression or an alternative encoding
  });

  it('control for the backup search: a plain dump of a database that DID hold a value would be caught', () => {
    // The same matcher over a fabricated dump line that carries each form of a value.
    for (const form of forms(FAMILY)) expect(findIn(`COPY public.t (c) FROM stdin;\n${form}\n\\.`).length).toBeGreaterThan(0);
  });

  // PD-2 end to end: what the API refuses to open
  describe('ciphertext moved to another field or patient does not decrypt (PD-2)', () => {
    async function twoPatients() {
      const clinician = await lab.person('dr', ['clinician']);
      const [a, b] = [await lab.patient(clinician), await lab.patient(clinician)];
      for (const p of [a, b]) await lab.api().post(`/api/v1/patients/${p}/demographics`).set(bearer(clinician.token)).send(body()).expect(201);
      return { clinician, a, b };
    }
    const read = (who: { token: string }, patientId: string) => lab.api().get(`/api/v1/patients/${patientId}/demographics`).set(bearer(who.token));
    const asOwner = async (work: (sql: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<void>) =>
      withAdmin(db.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica'); // the append-only triggers are the point of other tests; here we play someone who got past them
        await work((text, values) => c.query(text, values));
        await c.query('COMMIT');
      });

    it('refuses a version whose given-name and family-name columns were swapped (same patient, same key, another field)', async () => {
      const { clinician, a } = await twoPatients();
      await read(clinician, a).expect(200); // control
      await asOwner(async (sql) => {
        await sql(
          `UPDATE patient_demographics SET given_name_ct = family_name_ct, given_name_nonce = family_name_nonce, family_name_ct = given_name_ct, family_name_nonce = given_name_nonce WHERE patient_id = $1`,
          [a],
        );
      });
      const res = await read(clinician, a);
      expect(res.status).toBe(500);
      expect(res.body.error.message).toMatch(/could not be verified/);
      expect(findIn(res.text)).toEqual([]);
    });

    it('refuses patient A’s identity copied into patient B’s row, even with A’s own wrapped key beside it (the key is bound to its patient)', async () => {
      const { clinician, a, b } = await twoPatients();
      await read(clinician, b).expect(200); // control
      await asOwner(async (sql) => {
        await sql(
          `UPDATE patient_demographics d SET given_name_ct = s.given_name_ct, given_name_nonce = s.given_name_nonce, family_name_ct = s.family_name_ct, family_name_nonce = s.family_name_nonce,
                  date_of_birth_ct = s.date_of_birth_ct, date_of_birth_nonce = s.date_of_birth_nonce
             FROM patient_demographics s WHERE d.patient_id = $2 AND s.patient_id = $1`,
          [a, b],
        );
      });
      expect((await read(clinician, b)).status).toBe(500); // B's key does not open A's bytes
      await asOwner(async (sql) => {
        await sql(`UPDATE patient_field_keys k SET wrapped_key = s.wrapped_key FROM patient_field_keys s WHERE k.patient_id = $2 AND s.patient_id = $1`, [a, b]);
      });
      const res = await read(clinician, b);
      expect(res.status).toBe(503); // A's wrapped key does not unwrap for B: the encryption context (the patient) differs
      expect(findIn(res.text)).toEqual([]);
      expect((await read(clinician, a)).status).toBe(200); // A is untouched
    });
  });
});
