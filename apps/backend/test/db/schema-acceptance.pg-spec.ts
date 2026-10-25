import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { assertSchemaAcceptance } from '../helpers/schema-acceptance';

let pg: EphemeralDatabase;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
});
afterAll(async () => {
  await pg?.drop();
});

it('accepts all reviewed relationships and query-index definitions, with no unvalidated constraint', async () => {
  await withAdmin(pg.adminUrl, assertSchemaAcceptance);
});

it('catches the unvalidated state even though the FK name, columns and count are unchanged', async () => {
  await withAdmin(pg.adminUrl, async (c) => {
    const definition = (await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='upload_attempt_report_fk'")).rows[0].definition as string;
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE report_upload_attempts DROP CONSTRAINT upload_attempt_report_fk');
      await c.query(`ALTER TABLE report_upload_attempts ADD CONSTRAINT upload_attempt_report_fk ${definition.replace(/ NOT VALID$/, '')} NOT VALID`);
      await expect(assertSchemaAcceptance(c)).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
    }
    await assertSchemaAcceptance(c);
  });
});

it('catches an index with the correct name/count but wrong column order, then passes restored controls', async () => {
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('DROP INDEX patients_tenant_seq_idx');
      await c.query('CREATE INDEX patients_tenant_seq_idx ON patients (seq, tenant_id) WHERE deleted_at IS NULL');
      await expect(assertSchemaAcceptance(c)).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
    }
    await assertSchemaAcceptance(c);
  });
});

it('catches weakened patient agreement with the same FK name/count, then passes restored controls', async () => {
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE report_upload_attempts DROP CONSTRAINT upload_attempt_report_fk');
      await c.query(`ALTER TABLE report_upload_attempts ADD CONSTRAINT upload_attempt_report_fk FOREIGN KEY (report_id, tenant_id)
        REFERENCES reports (id, tenant_id) ON DELETE RESTRICT`);
      await expect(assertSchemaAcceptance(c)).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
    }
    await assertSchemaAcceptance(c);
  });
});

it('catches a missing field constraint instead of trusting an aggregate schema-object floor', async () => {
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE reports DROP CONSTRAINT reports_size_range');
      await expect(assertSchemaAcceptance(c)).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
    }
    await assertSchemaAcceptance(c);
  });
});
