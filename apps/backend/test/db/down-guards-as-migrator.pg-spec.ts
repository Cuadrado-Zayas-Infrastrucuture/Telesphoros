import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { provisionLogins, type SecretStore } from '../../src/db/provision-logins';
import { pgClientConfig } from '../../src/db/tls';
import { adminUrl, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, seedLabReport } from '../helpers/ledger-fixtures';
import { revertAbove, revertThrough } from '../helpers/migration-history';

/**
 * The "refuse to drop populated data" guards in the down migrations, run as the login an operator really uses: `telesphoros_migrator`, which owns
 * the tables, is NOT a superuser and does NOT bypass row-level security. A table with FORCE ROW LEVEL SECURITY and policies for other roles only shows
 * that login no rows, so a guard that just asks `EXISTS (SELECT 1 FROM that_table)` answers "empty" and the down drops the data without the refusal.
 * Every other down test runs as the cluster superuser, which sees every row; that is why this was never noticed.
 */
jest.setTimeout(240_000);

class MemoryStore implements SecretStore {
  values = new Map<string, string>();
  async get(id: string) {
    return this.values.get(id);
  }
  async put(id: string, value: string) {
    this.values.set(id, value);
  }
}

interface Fixture {
  admin: string;
  /** The application login's URL (what the API connects with). */
  app: string;
  migrator: Client;
  drop: () => Promise<void>;
}

const tenant = 'syn-down-guard';
const hash = 'a'.repeat(64);

async function fixture(): Promise<Fixture> {
  const tag = randomBytes(4).toString('hex');
  const database = `test_dg_${tag}`;
  const names = { app: `dg_app_${tag}`, verifier: `dg_ver_${tag}`, migrator: `dg_mig_${tag}`, worker: `dg_wrk_${tag}`, issuer: `dg_iss_${tag}` };
  await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${database}`));
  const base = new URL(adminUrl());
  const admin = new URL(base);
  admin.pathname = `/${database}`;
  const store = new MemoryStore();
  let migrator: Client | undefined;
  const drop = async () => {
    await migrator?.end().catch(() => undefined);
    await withAdmin(adminUrl(), async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const name of Object.values(names)) await c.query(`DROP ROLE IF EXISTS ${name}`);
    });
  };
  try {
    await provisionLogins({
      adminUrl: admin.toString(),
      tls: 'disable',
      target: { host: base.hostname, port: Number(base.port) },
      secrets: { app: 'a', verifier: 'v', migrator: 'm', worker: 'w' },
      store,
      names,
    });
    migrator = new Client(pgClientConfig(store.values.get('m')!, 'disable'));
    await migrator.connect();
    await migrateUp(migrator);
    return { admin: admin.toString(), app: store.values.get('a')!, migrator, drop };
  } catch (error) {
    await drop();
    throw error;
  }
}

const patient = async (c: Client, withRequest = false) =>
  (
    await c.query(`INSERT INTO patients (tenant_id, created_by, label, creation_request_id, creation_request_hash) VALUES ($1, 'syn-author', $2, $3, $4) RETURNING id`, [
      tenant,
      `SYN-${randomUUID()}`,
      withRequest ? randomUUID() : null,
      withRequest ? hash : null,
    ])
  ).rows[0].id as string;

const report = async (c: Client, patientId: string, columns = '', values: unknown[] = []) =>
  (
    await c.query(
      `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes${columns}) VALUES ($1, 'syn-author', $2, 'vcf', 'p.vcf', 1${values.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
      [tenant, patientId, ...values],
    )
  ).rows[0].id as string;

interface GuardCase {
  anchor: string;
  /** The session setting that allows the drop on purpose. */
  allow: string;
  refusal: RegExp;
  populate: (c: Client, f: Fixture) => Promise<void>;
}

const cases: GuardCase[] = [
  {
    anchor: 'report_evidence',
    allow: 'telesphoros.allow_audit_drop',
    refusal: /Refusing to drop report evidence columns that hold data/,
    populate: async (c) => {
      await report(c, await patient(c), ', upload_requested_by', ['syn-author']);
    },
  },
  {
    anchor: 'report_creation_requests',
    allow: 'telesphoros.allow_report_retry_drop',
    refusal: /Refusing to drop populated/,
    populate: async (c) => {
      await report(c, await patient(c), ', creation_request_id, creation_request_hash', [randomUUID(), hash]);
    },
  },
  {
    anchor: 'upload_attempts',
    allow: 'telesphoros.allow_upload_attempt_drop',
    refusal: /Refusing to drop populated upload attempts/,
    populate: async (c) => {
      const patientId = await patient(c);
      const reportId = await report(c, patientId);
      const run = randomUUID();
      await c.query('INSERT INTO report_upload_runs (run_id, tenant_id) VALUES ($1, $2)', [run, tenant]);
      await c.query(
        `INSERT INTO report_upload_attempts (request_id, run_id, tenant_id, report_id, patient_id, principal, revision, declaration_revision, type, size_bytes, content_type, sha256, storage_key, state, lease_until)
         VALUES ($1, $2, $3, $4, $5, 'syn-author', $6, $7, 'vcf', 1, 'text/x-vcf', $8, $9, 'declared', now() + interval '1 hour')`,
        [randomUUID(), run, tenant, reportId, patientId, randomUUID(), randomUUID(), 'b'.repeat(64), `k/${randomUUID()}`],
      );
    },
  },
  {
    anchor: 'patient_creation_requests',
    allow: 'telesphoros.allow_patient_retry_drop',
    refusal: /Refusing to drop populated patient creation retry identities/,
    populate: async (c) => {
      await patient(c, true);
    },
  },
  {
    anchor: 'identifier_creation_requests',
    allow: 'telesphoros.allow_identifier_retry_drop',
    refusal: /Refusing to drop populated identifier creation retry identities/,
    populate: async (c) => {
      await c.query(
        `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by, creation_request_id, creation_request_hash)
         VALUES ($1, $2, 'mrn', decode($3, 'hex'), 'syn-author', $4, $5)`,
        [tenant, await patient(c), 'c'.repeat(64), randomUUID(), hash],
      );
    },
  },
  {
    anchor: 'capture_decision_requests',
    allow: 'telesphoros.allow_capture_decision_retry_drop',
    refusal: /Refusing to drop populated capture decision retry identities/,
    // A ledger record: written the way the API writes it, through the application login.
    populate: async (_c, f) => {
      const database = new Database({ url: f.app, ssl: 'disable' });
      try {
        const repo = new PostgresLedgerRecordsRepository(database);
        const report = await seedLabReport(f.admin, tenant);
        const capture = captureFor(report);
        const stored = await repo.insertCapture(tenant, report.uploader, capture);
        const hash = createHash('sha256').update('request').digest('hex');
        await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture, { request: { id: randomUUID(), hash } }));
      } finally {
        await database.onModuleDestroy();
      }
    },
  },
  {
    anchor: 'dispute_creation_requests',
    allow: 'telesphoros.allow_dispute_retry_drop',
    refusal: /Refusing to drop populated dispute creation retry identities/,
    // A ledger record: written the way the API writes it, through the application login.
    populate: async (_c, f) => {
      const database = new Database({ url: f.app, ssl: 'disable' });
      try {
        await new PostgresLedgerRecordsRepository(database).raiseDispute(tenant, 'syn-reviewer', {
          guidelineId: 'syn-guideline',
          guidelineVersion: '1',
          guidelineContentSha256: 'c'.repeat(64),
          locator: { table: 'recommendations', row: 'r1' },
          note: 'reads wrongly',
          request: { id: randomUUID(), hash: createHash('sha256').update('dispute').digest('hex') },
        });
      } finally {
        await database.onModuleDestroy();
      }
    },
  },
];

/** Whether each of these tables that still exists is FORCE ROW LEVEL SECURITY (a table a rollback has removed is not asked about). */
const stillForced = async (c: Client) =>
  (
    await c.query<{ relname: string; f: boolean }>(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('reports', 'patients', 'patient_identifiers', 'capture_acceptances', 'cell_disputes') ORDER BY 1`,
    )
  ).rows;

const setting = (c: Client, name: string, value: string) => c.query('SELECT set_config($1, $2, false)', [name, value]);
const AUDIT = 'telesphoros.allow_audit_drop';

/**
 * The audit migrations (0005 to 0009, 0020, 0021) refuse unconditionally unless `allow_audit_drop` is set, and 0010's own guard uses the same setting.
 * So everything ABOVE the migration under test is reverted first with that setting on, then it is switched off and the migration under test is reverted alone.
 */
async function revertAboveThenSwitchOff(c: Client, anchor: string): Promise<void> {
  const above = revertAbove(anchor);
  await setting(c, AUDIT, 'yes');
  expect(await migrateDown(c, above.steps)).toEqual(above.reverted);
  await setting(c, AUDIT, '');
}

describe('down-migration guards, run as the migrator login (owner of the tables, no BYPASSRLS)', () => {
  it.each(cases)('$anchor: a populated table is refused, the refusal rolls back whole, and the setting that allows it still works', async (guard) => {
    const f = await fixture();
    try {
      const me = (await f.migrator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      expect(me).toEqual({ rolsuper: false, rolbypassrls: false }); // the login under test is the restricted one
      await withAdmin(f.admin, (c) => guard.populate(c, f));
      const version = revertThrough(guard.anchor).reverted.at(-1)!;
      await revertAboveThenSwitchOff(f.migrator, guard.anchor);

      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(guard.refusal);
      // The refusal left nothing half done: the version is still applied and the tables are still forced.
      expect((await f.migrator.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount).toBe(1);
      const before = await stillForced(f.migrator);
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((t) => t.f)).toBe(true);

      await setting(f.migrator, guard.allow, 'yes');
      expect(await migrateDown(f.migrator, 1)).toEqual([version]);
      expect((await stillForced(f.migrator)).every((t) => t.f)).toBe(true); // lifting FORCE for the check did not outlive the migration
    } finally {
      await f.drop();
    }
  });

  it('with nothing in those tables every one of these rollbacks goes through, so a guard refuses populated data and not everything', async () => {
    const f = await fixture();
    try {
      const through = revertThrough('report_evidence');
      await setting(f.migrator, AUDIT, 'yes'); // for the unconditional audit guards above 0010
      const above = revertAbove('report_evidence');
      expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
      await setting(f.migrator, AUDIT, '');
      expect(await migrateDown(f.migrator, 1)).toEqual([through.reverted.at(-1)]);
      expect((await stillForced(f.migrator)).every((t) => t.f)).toBe(true);
    } finally {
      await f.drop();
    }
  });
});
