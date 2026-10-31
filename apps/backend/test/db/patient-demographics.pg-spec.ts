import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { loadProjections } from '../../src/ledger/projections';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { openField, sealField } from '../../src/patient-demographics/identity-crypto';
import { FieldKeyRaceError, IdentityErasedError, type NewDemographics } from '../../src/storage/patient-demographics.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresPatientDemographicsRepository } from '../../src/storage/postgres/patient-demographics.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { seedLabReport } from '../helpers/ledger-fixtures';
import { attempt, type PgError } from '../helpers/ledger-sql';

// Spec 025 PD-a at the database: the wrapped keys, the demographics record, its ledger event, and the erasure. Expected values are written by hand; the oracle is
// the database's own refusal (error code and constraint name), the stored rows, or the verifier. Synthetic data only: every name and date here is invented.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
const ACTOR = 'syn-clinician';
const GIVEN = 'Synthetic-Zzyzx-Given';
const FAMILY = 'Synthetic-Qwerty-Family';
const DOB = '1971-02-03';

(usingPostgres ? describe : describe.skip)('patient demographics (migration 0064)', () => {
  let db: EphemeralDatabase;
  let database: Database;
  let repo: PostgresPatientDemographicsRepository;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
    repo = new PostgresPatientDemographicsRepository(database, new PostgresLedgerRecordsRepository(database));
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  afterAll(async () => {
    await verifier.close();
    await database.onModuleDestroy();
    await db.drop();
  });

  const rows = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(db.adminUrl, async (c) => (await c.query(sql, values)).rows as T[]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  interface World {
    tenant: string;
    patient: string;
    dataKey: Buffer;
  }
  async function world(): Promise<World> {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const report = await seedLabReport(db.adminUrl, tenant);
    return { tenant, patient: report.patientId, dataKey: randomBytes(32) };
  }

  /** A well-formed version for the world, sealed with its data key. `over` replaces any field. */
  function version(w: World, over: Partial<NewDemographics> = {}): NewDemographics {
    const binding = { tenant: w.tenant, patient: w.patient, keyVersion: 1 };
    return {
      id: randomUUID(),
      patientId: w.patient,
      keyVersion: 1,
      givenName: sealField(w.dataKey, binding, 'given_name', GIVEN),
      familyName: sealField(w.dataKey, binding, 'family_name', FAMILY),
      dateOfBirth: sealField(w.dataKey, binding, 'date_of_birth', DOB),
      sex: 'female',
      birthYear: 1971,
      ethnicity: ['asian', 'white'],
      ...over,
    };
  }
  const wrapped = () => randomBytes(61);
  const firstVersion = (w: World, over: Partial<NewDemographics> = {}) => version(w, { newKey: { keyVersion: 1, wrapped: wrapped(), provider: 'local' }, ...over });

  /** Runs raw SQL as the application role in a transaction bound to the world's tenant and the actor. */
  const asApp = (w: World | string, work: (c: Client) => Promise<unknown>, actor: string | null = ACTOR) => attempt(db.appUrl, typeof w === 'string' ? w : w.tenant, actor, work);

  const insertSql = (columns: Record<string, unknown>) => {
    const keys = Object.keys(columns);
    return [`INSERT INTO patient_demographics (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => columns[k])] as const;
  };
  /** The columns of a raw INSERT for version `v` of the world; `over` replaces any of them. */
  function rawColumns(w: World, v: NewDemographics, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: v.id,
      tenant_id: w.tenant,
      created_by: ACTOR,
      ledger_event_id: randomUUID(),
      patient_id: w.patient,
      version: 1,
      key_version: 1,
      given_name_ct: v.givenName.ciphertext,
      given_name_nonce: v.givenName.nonce,
      family_name_ct: v.familyName.ciphertext,
      family_name_nonce: v.familyName.nonce,
      date_of_birth_ct: v.dateOfBirth.ciphertext,
      date_of_birth_nonce: v.dateOfBirth.nonce,
      sex: v.sex,
      birth_year: v.birthYear,
      ethnicity: v.ethnicity,
      ...over,
    };
  }
  /** Stores the world's key through the repository (with a first version), so a raw INSERT in the world's tenant has a key to meet. */
  async function keyed(w: World) {
    await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
  }

  describe('a stored version', () => {
    it('stores ciphertext and the coded columns, and not one plaintext identity value anywhere in the row', async () => {
      const w = await world();
      const stored = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      expect(stored).toMatchObject({ version: 1, keyVersion: 1, sex: 'female', birthYear: 1971, ethnicity: ['asian', 'white'], createdBy: ACTOR, patientId: w.patient });
      const [row] = await rows<Record<string, unknown>>('SELECT * FROM patient_demographics WHERE id = $1', [stored.id]);
      const asText = JSON.stringify(row, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v)); // bytea as hex: a plaintext value would not survive as text
      for (const value of [GIVEN, FAMILY, DOB, '1971-02-03', 'Zzyzx', 'Qwerty']) expect(asText).not.toContain(value);
      const binding = { tenant: w.tenant, patient: w.patient, keyVersion: 1 };
      expect(openField(w.dataKey, binding, 'given_name', stored.givenName)).toBe(GIVEN); // control: what was stored is the sealed value, and it opens
    });

    it('assigns version numbers 1, 2, 3 in order (the repository always sends 1: the trigger overwrites it), and the first call stores the key with it', async () => {
      const w = await world();
      const first = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      const second = await repo.insertVersion(w.tenant, ACTOR, version(w));
      const third = await repo.insertVersion(w.tenant, ACTOR, version(w, { sex: 'male' }));
      expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);
      expect(await rows('SELECT version FROM patient_demographics WHERE patient_id = $1 ORDER BY seq', [w.patient])).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(await rows('SELECT count(*)::int AS n FROM patient_field_keys WHERE patient_id = $1', [w.patient])).toEqual([{ n: 1 }]);
    });

    it('numbers concurrent corrections without a gap or a duplicate (the per-patient lock)', async () => {
      const w = await world();
      await keyed(w);
      const made = await Promise.all(Array.from({ length: 6 }, () => repo.insertVersion(w.tenant, ACTOR, version(w))));
      expect(made.map((m) => m.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
      expect(await rows('SELECT version FROM patient_demographics WHERE patient_id = $1 ORDER BY version', [w.patient])).toHaveLength(7);
    });

    it('a version without its ledger event is refused at COMMIT, and the refusal leaves nothing behind', async () => {
      const w = await world();
      await keyed(w);
      const before = await rows<{ n: number }>('SELECT count(*)::int AS n FROM patient_demographics WHERE patient_id = $1', [w.patient]);
      const error = await asApp(w, (c) => c.query(...insertSql(rawColumns(w, version(w)))));
      expect(error).toMatchObject({ code: '23503' }); // the deferred foreign key to its ledger event
      expect(await rows('SELECT count(*)::int AS n FROM patient_demographics WHERE patient_id = $1', [w.patient])).toEqual(before);
    });

    it('each version has exactly one event of type patient-demographics, and the projection carries ciphertext digests only (PD-5, D5)', async () => {
      const w = await world();
      const a = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      const b = await repo.insertVersion(w.tenant, ACTOR, version(w, { sex: 'male' }));
      const events = await rows<{ event_type: string; subject_table: string; subject_id: string }>(
        `SELECT event_type, subject_table, subject_id::text AS subject_id FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`,
        [w.tenant],
      );
      expect(events).toEqual([
        { event_type: 'patient-demographics', subject_table: 'patient_demographics', subject_id: a.id },
        { event_type: 'patient-demographics', subject_table: 'patient_demographics', subject_id: b.id },
      ]);
      const client = new Client({ connectionString: db.verifierUrl });
      await client.connect();
      try {
        const projection = (await loadProjections(client, 'patient_demographics', [a.id])).get(a.id)!;
        expect(projection).toMatchObject({
          kind: 'patient-demographics',
          patientId: w.patient,
          version: 1,
          keyVersion: 1,
          sex: 'female',
          birthYear: 1971,
          ethnicity: ['asian', 'white'],
          givenNameSha256: sha(Buffer.concat([a.givenName.nonce, a.givenName.ciphertext])),
          familyNameSha256: sha(Buffer.concat([a.familyName.nonce, a.familyName.ciphertext])),
          dateOfBirthSha256: sha(Buffer.concat([a.dateOfBirth.nonce, a.dateOfBirth.ciphertext])),
        });
        const text = JSON.stringify(projection);
        for (const value of [GIVEN, FAMILY, DOB, a.givenName.ciphertext.toString('hex'), a.givenName.ciphertext.toString('base64'), a.dateOfBirth.ciphertext.toString('hex')]) {
          expect(text).not.toContain(value); // no plaintext, and not the ciphertext either
        }
        expect(Object.keys(projection)).not.toContain('creationRequestHash');
      } finally {
        await client.end();
      }
    });

    it('the ledger verifies across versions, and goes red when a stored ciphertext is altered (a check that can fail)', async () => {
      const w = await world();
      const a = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      await repo.insertVersion(w.tenant, ACTOR, version(w));
      await repo.insertVersion(w.tenant, ACTOR, version(w, { ethnicity: null, sex: null }));
      expect(await verifier.verify(w.tenant)).toMatchObject({ status: 'ok', eventsChecked: 3, failures: [] });
      // Tamper as the cluster superuser with triggers off: flip one byte of the stored given-name ciphertext.
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE patient_demographics SET given_name_ct = set_byte(given_name_ct, 0, get_byte(given_name_ct, 0) # 1) WHERE id = $1`, [a.id]);
        await c.query('COMMIT');
      });
      const tampered = await verifier.verify(w.tenant);
      expect(tampered.status).toBe('failed');
      expect(tampered.failures.map((f) => f.kind)).toContain('payload-mismatch');
    });
  });

  describe('the table refuses what the vocabulary does not allow (PD-4)', () => {
    const refused = async (over: (w: World) => Record<string, unknown>, constraint: string) => {
      const w = await world();
      await keyed(w);
      const error = (await asApp(w, async (c) => {
        await c.query(...insertSql(rawColumns(w, version(w), over(w))));
      })) as PgError;
      expect({ code: error?.code, constraint: error?.constraint }).toEqual({ code: '23514', constraint });
    };

    it.each([
      ['a sex that is not male or female', { sex: 'unknown' }, 'patient_demographics_sex'],
      ['a third sex code', { sex: 'other' }, 'patient_demographics_sex'],
      ['a sex in the wrong case', { sex: 'Female' }, 'patient_demographics_sex'],
      ['an unknown ethnicity code', { ethnicity: ['asian', 'martian'] }, 'patient_demographics_ethnicity'],
      ['the old "unknown" ethnicity code', { ethnicity: ['unknown'] }, 'patient_demographics_ethnicity'],
      ['a declined code', { ethnicity: ['declined'] }, 'patient_demographics_ethnicity'],
      ['an empty ethnicity list (empty means NULL)', { ethnicity: [] }, 'patient_demographics_ethnicity'],
      ['a repeated ethnicity code', { ethnicity: ['asian', 'asian'] }, 'patient_demographics_ethnicity'],
      ['a NULL element in the ethnicity list', { ethnicity: ['asian', null] }, 'patient_demographics_ethnicity'],
      ['a birth year before 1900', { birth_year: 1899 }, 'patient_demographics_birth_year'],
      ['a birth year after 2100', { birth_year: 2101 }, 'patient_demographics_birth_year'],
      ['a nonce of the wrong length', { given_name_nonce: randomBytes(11) }, 'patient_demographics_nonces'],
      ['a date of birth ciphertext of the wrong length', { date_of_birth_ct: randomBytes(25) }, 'patient_demographics_dob_len'],
      ['a name ciphertext with no body', { family_name_ct: randomBytes(16) }, 'patient_demographics_name_len'],
      ['a name ciphertext over the bound', { given_name_ct: randomBytes(417) }, 'patient_demographics_name_len'],
      ['a name ciphertext one byte short of the padded length', { given_name_ct: randomBytes(417) }, 'patient_demographics_name_len'],
      ['a name ciphertext one byte over the padded length', { family_name_ct: randomBytes(419) }, 'patient_demographics_name_len'],
      ['a request id without its fingerprint', { creation_request_id: randomUUID() }, 'patient_demographics_request_pair'],
      ['a fingerprint that is not 64 hex characters', { creation_request_id: randomUUID(), creation_request_hash: 'abc' }, 'patient_demographics_request_hash'],
    ])('refuses %s', async (_label, columns, constraint) => {
      await refused(() => columns, constraint);
    });

    it.each([
      ['a key version that was never created', 2],
      ['a key version of zero', 0],
    ])('refuses %s: a version must name a key that exists (PD001, raised before any CHECK)', async (_label, keyVersion) => {
      const w = await world();
      await keyed(w);
      expect(await asApp(w, (c) => c.query(...insertSql(rawColumns(w, version(w), { key_version: keyVersion }))))).toMatchObject({ code: 'PD001' });
    });

    it('control: the same row with valid codes is accepted by the table (refused only for the missing event at COMMIT)', async () => {
      const w = await world();
      await keyed(w);
      const error = await asApp(w, (c) => c.query(...insertSql(rawColumns(w, version(w), { sex: 'male', ethnicity: ['hispanic-or-latino', 'white'], birth_year: 2100 }))));
      expect(error?.constraint).toBe('patient_demographics_event_fk'); // no CHECK fired; the only refusal is the missing ledger event, at COMMIT
    });

    it('accepts every code of the D3 list, one at a time and all seven together, and both sexes and NULL', async () => {
      const w = await world();
      await keyed(w);
      const all = [
        'american-indian-or-alaska-native',
        'asian',
        'black-or-african-american',
        'hispanic-or-latino',
        'middle-eastern-or-north-african',
        'native-hawaiian-or-pacific-islander',
        'white',
      ] as const;
      for (const ethnicity of [...all.map((c) => [c]), [...all], null]) await repo.insertVersion(w.tenant, ACTOR, version(w, { ethnicity: ethnicity as never }));
      for (const sex of ['male', 'female', null] as const) await repo.insertVersion(w.tenant, ACTOR, version(w, { sex }));
      expect(await rows('SELECT count(*)::int AS n FROM patient_demographics WHERE patient_id = $1', [w.patient])).toEqual([{ n: 1 + 9 + 3 }]);
    });
  });

  describe('append-only, tenant-isolated, and closed to the worker', () => {
    it('nobody updates, deletes or truncates a version: the application, the owner and a superuser included', async () => {
      const w = await world();
      const v = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      await withAdmin(db.adminUrl, async (c) => {
        await expect(c.query(`UPDATE patient_demographics SET sex = 'male' WHERE id = $1`, [v.id])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`DELETE FROM patient_demographics WHERE id = $1`, [v.id])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`TRUNCATE patient_demographics`)).rejects.toMatchObject({ code: '23000' });
      });
      const app = new Client({ connectionString: db.appUrl });
      await app.connect();
      try {
        for (const sql of [`UPDATE patient_demographics SET sex = 'male'`, `DELETE FROM patient_demographics`, `TRUNCATE patient_demographics`]) {
          await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await app.end();
      }
      expect(await rows('SELECT sex FROM patient_demographics WHERE id = $1', [v.id])).toEqual([{ sex: 'female' }]);
    });

    it('FORCE row-level security: another organization sees nothing, its own sees the row, and a row cannot be written for a tenant or person other than the bound ones', async () => {
      expect(await rows(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('patient_demographics', 'patient_field_keys') ORDER BY 1`)).toEqual([
        { relname: 'patient_demographics', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'patient_field_keys', relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const a = await world();
      const b = await world();
      await keyed(a);
      await keyed(b);
      const seen = async (tenant: string, table: string) => {
        let tenants: string[] = [];
        const error = await asApp(tenant, async (c) => {
          tenants = (await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`)).rows.map((r) => r.tenant_id);
        });
        expect(error).toBeUndefined();
        return tenants;
      };
      for (const table of ['patient_demographics', 'patient_field_keys']) {
        expect(await seen(a.tenant, table)).toEqual([a.tenant]); // positive control
        expect(await seen(b.tenant, table)).toEqual([b.tenant]);
        expect(await seen(`t-${randomUUID().slice(0, 8)}`, table)).toEqual([]);
      }
      // A's version written inside B's transaction, and a version by someone other than the bound person.
      expect(await asApp(b.tenant, (c) => c.query(...insertSql(rawColumns(a, version(a)))))).toMatchObject({ code: '42501' });
      expect(await asApp(a, (c) => c.query(...insertSql(rawColumns(a, version(a), { created_by: 'syn-someone-else' }))))).toMatchObject({ code: '42501' });
      // The same for a key.
      const keyColumns = (w: World, over: Record<string, unknown> = {}) => ({
        tenant_id: w.tenant,
        patient_id: w.patient,
        key_version: 2,
        wrapped_key: wrapped(),
        provider: 'local',
        created_by: ACTOR,
        ...over,
      });
      const keySql = (c: Record<string, unknown>) =>
        [
          `INSERT INTO patient_field_keys (${Object.keys(c).join(', ')}) VALUES (${Object.keys(c)
            .map((_, i) => `$${i + 1}`)
            .join(', ')})`,
          Object.values(c),
        ] as const;
      expect(await asApp(b.tenant, (c) => c.query(...keySql(keyColumns(a))))).toMatchObject({ code: '42501' });
      expect(await asApp(a, (c) => c.query(...keySql(keyColumns(a, { created_by: 'syn-someone-else' }))))).toMatchObject({ code: '42501' });
    });

    it('privileges: the application reads and inserts; the ledger roles read demographics only; the worker, the issuer and the auditor hold nothing on either table', async () => {
      const grants = await rows<{ grantee: string; priv: string; tbl: string }>(
        `SELECT grantee, privilege_type AS priv, table_name AS tbl FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name IN ('patient_demographics', 'patient_field_keys') AND grantee LIKE 'telesphoros_%' ORDER BY 3, 1, 2`,
      );
      const by = (table: string) => grants.filter((g) => g.tbl === table).map((g) => `${g.grantee}:${g.priv}`);
      expect(by('patient_demographics')).toEqual(['telesphoros_app:INSERT', 'telesphoros_app:SELECT', 'telesphoros_ledger:SELECT', 'telesphoros_ledger_verifier:SELECT']);
      expect(by('patient_field_keys')).toEqual(['telesphoros_app:INSERT', 'telesphoros_app:SELECT']);
      for (const login of [db.workerUrl, db.issuerUrl, db.auditorUrl, db.operatorUrl]) {
        const c = new Client({ connectionString: login });
        await c.connect();
        try {
          for (const table of ['patient_demographics', 'patient_field_keys']) {
            await expect(c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
          }
        } finally {
          await c.end();
        }
      }
    });
  });

  describe('the key table and erasure (D8, PD-8)', () => {
    it('one key per patient: a second key for the same patient is refused (the repository reports a lost race)', async () => {
      const w = await world();
      await keyed(w);
      await expect(repo.insertVersion(w.tenant, ACTOR, version(w, { newKey: { keyVersion: 1, wrapped: wrapped(), provider: 'local' } }))).rejects.toBeInstanceOf(FieldKeyRaceError);
      expect(await rows('SELECT count(*)::int AS n FROM patient_demographics WHERE patient_id = $1', [w.patient])).toEqual([{ n: 1 }]); // the refused version was not stored
    });

    it('a key is not updated or deleted by the application, and not deleted by a stray DELETE even from a superuser', async () => {
      const w = await world();
      await keyed(w);
      const app = new Client({ connectionString: db.appUrl });
      await app.connect();
      try {
        for (const sql of [`UPDATE patient_field_keys SET provider = 'kms'`, `DELETE FROM patient_field_keys`, `TRUNCATE patient_field_keys`]) {
          await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await app.end();
      }
      await withAdmin(db.adminUrl, async (c) => {
        await expect(c.query(`DELETE FROM patient_field_keys WHERE patient_id = $1`, [w.patient])).rejects.toMatchObject({ code: '42501' }); // the delete guard
        await expect(c.query(`UPDATE patient_field_keys SET provider = 'kms' WHERE patient_id = $1`, [w.patient])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`TRUNCATE patient_field_keys`)).rejects.toMatchObject({ code: '23000' });
      });
      expect(await rows('SELECT count(*)::int AS n FROM patient_field_keys WHERE patient_id = $1', [w.patient])).toEqual([{ n: 1 }]);
    });

    it('patient_field_key_erase() is executable by no login, and destroys exactly one key', async () => {
      const w = await world();
      const other = await world();
      await keyed(w);
      await keyed(other);
      for (const url of [db.appUrl, db.workerUrl, db.verifierUrl, db.issuerUrl]) {
        const c = new Client({ connectionString: url });
        await c.connect();
        try {
          await expect(c.query('SELECT patient_field_key_erase($1, $2)', [w.tenant, w.patient])).rejects.toMatchObject({ code: '42501' });
        } finally {
          await c.end();
        }
      }
      expect(await rows('SELECT count(*)::int AS n FROM patient_field_keys')).toMatchObject([{ n: expect.any(Number) }]);
      await withAdmin(db.adminUrl, async (c) => {
        expect((await c.query('SELECT patient_field_key_erase($1, $2) AS destroyed', [w.tenant, w.patient])).rows).toEqual([{ destroyed: true }]);
        expect((await c.query('SELECT patient_field_key_erase($1, $2) AS destroyed', [w.tenant, w.patient])).rows).toEqual([{ destroyed: false }]); // already gone
        expect((await c.query('SELECT patient_field_key_erase($1, $2) AS destroyed', ['t-nobody', randomUUID()])).rows).toEqual([{ destroyed: false }]);
        // The setting that unlocks the delete guard does not outlive the function.
        expect((await c.query(`SELECT current_setting('telesphoros.field_key_erasure', true) AS s`)).rows[0].s).not.toBe('on');
      });
      expect(await rows('SELECT 1 FROM patient_field_keys WHERE patient_id = $1', [w.patient])).toEqual([]);
      expect(await rows('SELECT 1 FROM patient_field_keys WHERE patient_id = $1', [other.patient])).toHaveLength(1); // the neighbour kept its key
    });

    it('after erasure: every version stays (ledger intact), none can be opened, no new version or key can be written, and the ledger still verifies', async () => {
      const w = await world();
      const first = await repo.insertVersion(w.tenant, ACTOR, firstVersion(w));
      await repo.insertVersion(w.tenant, ACTOR, version(w));
      await withAdmin(db.adminUrl, (c) => c.query('SELECT patient_field_key_erase($1, $2)', [w.tenant, w.patient]));

      expect((await repo.keyState(w.tenant, w.patient)).key).toBeUndefined();
      expect((await repo.keyState(w.tenant, w.patient)).hasVersions).toBe(true);
      expect(await repo.versions(w.tenant, w.patient)).toHaveLength(2); // the ciphertext is still there ...
      expect(() => openField(randomBytes(32), { tenant: w.tenant, patient: w.patient, keyVersion: 1 }, 'given_name', first.givenName)).toThrow(); // ... and no key opens it
      await expect(repo.insertVersion(w.tenant, ACTOR, version(w))).rejects.toBeInstanceOf(IdentityErasedError); // a version needs a key
      await expect(repo.insertVersion(w.tenant, ACTOR, version(w, { newKey: { keyVersion: 1, wrapped: wrapped(), provider: 'local' } }))).rejects.toBeInstanceOf(
        IdentityErasedError,
      ); // and none can be made
      expect(await rows('SELECT count(*)::int AS n FROM patient_demographics WHERE patient_id = $1', [w.patient])).toEqual([{ n: 2 }]);
      expect(await verifier.verify(w.tenant)).toMatchObject({ status: 'ok', eventsChecked: 2, failures: [] });
    });

    it('a version for a soft-deleted patient is refused, and the key written with it is rolled back', async () => {
      const w = await world();
      await withAdmin(db.adminUrl, async (c) => {
        const bare = randomUUID();
        await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, $3, $4)`, [bare, w.tenant, ACTOR, `SYN-${bare.slice(0, 8)}`]);
        await c.query(`UPDATE patients SET deleted_at = now() WHERE id = $1`, [bare]);
        w.patient = bare;
      });
      await expect(repo.insertVersion(w.tenant, ACTOR, firstVersion(w))).rejects.toMatchObject({ code: '23000' });
      expect(await rows('SELECT 1 FROM patient_field_keys WHERE patient_id = $1', [w.patient])).toEqual([]);
    });
  });

  describe('coded reads', () => {
    it('codedFor returns the latest version of each patient, only the coded columns, and nothing for other organizations', async () => {
      const a = await world();
      const b = await world();
      await repo.insertVersion(a.tenant, ACTOR, firstVersion(a, { sex: 'male', ethnicity: null }));
      await repo.insertVersion(a.tenant, ACTOR, version(a, { sex: 'female', ethnicity: ['white'], birthYear: 1972 }));
      await repo.insertVersion(b.tenant, ACTOR, firstVersion(b, { sex: 'male' }));
      const seen = await repo.codedFor(a.tenant, [a.patient, b.patient, randomUUID()]);
      expect([...seen.keys()]).toEqual([a.patient]);
      expect(seen.get(a.patient)).toEqual({ version: 2, sex: 'female', birthYear: 1972, ethnicity: ['white'] });
      expect(Object.keys(seen.get(a.patient)!).sort()).toEqual(['birthYear', 'ethnicity', 'sex', 'version']);
      expect((await repo.codedFor(a.tenant, [])).size).toBe(0);
    });
  });
});
