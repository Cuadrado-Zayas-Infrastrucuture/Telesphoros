import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, withAdmin } from '../helpers/database';
import { seedLabReport } from '../helpers/ledger-fixtures';
import { migrationsThrough } from '../helpers/migrations-through';

// The product stores no raw genomic data (founder decision, 2026-10-28). Migration 0058 removes the `vcf` report type from both CHECKs. These tests
// prove, on a real database, that (1) the database itself refuses a VCF report or upload attempt at head, with a positive control for the types that
// stay, and (2) the migration refuses, and rewrites nothing, when a VCF row already exists. Synthetic rows only.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
const code = async (work: () => Promise<unknown>) =>
  work().then(
    () => undefined,
    (error: { code?: string; constraint?: string; message?: string }) => error,
  );

/** A report row of `type`, inserted as the owner, for a fresh patient. Not uploaded, so no lab-PDF pin applies. */
async function insertReport(c: Client, tenantId: string, type: string, extension: string, contentType: string) {
  const patientId = randomUUID();
  const reportId = randomUUID();
  await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-test', 'syn-test') ON CONFLICT (id) DO NOTHING`, [tenantId]);
  await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-test', $3)`, [patientId, tenantId, `SYN-${reportId.slice(0, 8)}`]);
  await c.query(
    `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, storage_key)
     VALUES ($1, $2, 'syn-test', $3, $4, $5, 100, 'received', $6, $7)`,
    [reportId, tenantId, patientId, type, `syn${extension}`, contentType, `k/${reportId}`],
  );
  return { patientId, reportId };
}

(usingPostgres ? describe : describe.skip)('no raw genomic data (migration 0058)', () => {
  it('at head, the database refuses a vcf report and a vcf upload attempt; structured and lab-pdf are still accepted (control)', async () => {
    const db = await createEphemeralDatabase();
    try {
      await withAdmin(db.adminUrl, async (c) => {
        const tenant = `t-${randomUUID().slice(0, 8)}`;
        const refused = await code(() => insertReport(c, tenant, 'vcf', '.vcf', 'text/x-vcf'));
        expect(refused).toMatchObject({ code: '23514', constraint: 'reports_type_valid' });
        const structured = await insertReport(c, tenant, 'structured', '.json', 'application/json'); // control
        await seedLabReport(db.adminUrl, tenant); // control: lab-pdf

        const attempt = (type: string) =>
          code(async () => {
            const run = randomUUID();
            await c.query('INSERT INTO report_upload_runs (run_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [run, tenant]);
            await c.query(
              `INSERT INTO report_upload_attempts (request_id, run_id, tenant_id, report_id, patient_id, principal, revision, declaration_revision, type, size_bytes,
                                                   content_type, sha256, storage_key, state, lease_until)
               VALUES ($1, $2, $3, $4, $5, 'syn-author', $6, $7, $8, 1, $9, $10, $11, 'declared', now() + interval '1 hour')`,
              [
                randomUUID(),
                run,
                tenant,
                structured.reportId,
                structured.patientId,
                randomUUID(),
                randomUUID(),
                type,
                type === 'vcf' ? 'text/x-vcf' : 'application/json',
                'b'.repeat(64),
                `k/${randomUUID()}`,
              ],
            );
          });
        expect(await attempt('vcf')).toMatchObject({ code: '23514', constraint: 'report_upload_attempts_type_check' });
        expect(await attempt('structured')).toBeUndefined(); // control
      });
    } finally {
      await db.drop();
    }
  });

  it('refuses to migrate when a vcf report exists, changes nothing, and keeps the row; without one it applies (control)', async () => {
    const populated = await createEphemeralDatabase({ migrate: false });
    const empty = await createEphemeralDatabase({ migrate: false });
    try {
      const throughPrevious = migrationsThrough('0057');
      let vcfReport = '';
      await withAdmin(populated.adminUrl, async (c) => {
        await migrateUp(c, throughPrevious);
        vcfReport = (await insertReport(c, `t-${randomUUID().slice(0, 8)}`, 'vcf', '.vcf', 'text/x-vcf')).reportId;
      });
      await withAdmin(populated.adminUrl, async (c) => {
        await expect(migrateUp(c)).rejects.toThrow(/Refusing to remove the vcf report type/);
        expect((await c.query(`SELECT 1 FROM schema_migrations WHERE version = '0058'`)).rowCount).toBe(0);
        expect((await c.query(`SELECT type FROM reports WHERE id = $1`, [vcfReport])).rows).toEqual([{ type: 'vcf' }]); // never rewritten
        const definition = (await c.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'reports_type_valid'`)).rows[0].d as string;
        expect(definition).toContain("'vcf'"); // the old CHECK is still in place
      });
      await withAdmin(empty.adminUrl, async (c) => {
        await migrateUp(c, throughPrevious);
        expect(await migrateUp(c)).toContain('0058');
      });
    } finally {
      await populated.drop();
      await empty.drop();
    }
  });
});
