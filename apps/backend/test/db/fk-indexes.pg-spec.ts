import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

let ephemeral: EphemeralDatabase;
beforeAll(async () => {
  ephemeral = await createEphemeralDatabase();
});
afterAll(async () => {
  await ephemeral.drop();
});

/**
 * A foreign key with no index on its referencing columns makes a delete (or key change) of the PARENT row scan the child table. The audit (item 13)
 * listed five such keys and asked for indexes. They were not added: in this schema no parent row is ever deleted by the application role (the
 * ledger and note tables refuse deletes, and the application role holds no DELETE on any parent), and the queries that touch these columns read from
 * the child to the parent by the parent's primary key. An index would cost every insert and be read by nothing.
 *
 * What this pins is the condition that makes that true: a foreign key may go without a covering index only while the application role cannot delete
 * from its parent. A parent the application can delete from needs the index (FK columns as leading columns, in any order).
 */
const UNCOVERED_WITH_DELETABLE_PARENT = `
  SELECT c.conrelid::regclass::text AS child, c.conname AS fk, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
     AND has_table_privilege('telesphoros_app', c.confrelid, 'DELETE')
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid AND i.indisvalid
          AND (SELECT array_agg(k ORDER BY k) FROM unnest((i.indkey::int2[])[0:cardinality(c.conkey) - 1]) k)
            = (SELECT array_agg(k ORDER BY k) FROM unnest(c.conkey) k))
   ORDER BY 1, 2`;

describe('foreign keys without a covering index (audit item 13)', () => {
  it('none has a parent the application role can delete from', async () => {
    const rows = await withAdmin(ephemeral.adminUrl, async (c) => (await c.query<{ child: string; fk: string }>(UNCOVERED_WITH_DELETABLE_PARENT)).rows);
    expect(rows.map((r) => `${r.child}.${r.fk}`)).toEqual([]);
  });

  it('the check can fail (control: an unindexed key on a parent the application role may delete from is reported; indexing it clears it)', async () => {
    const found = await withAdmin(ephemeral.adminUrl, async (c) => {
      await c.query('CREATE TABLE zz_parent (id int PRIMARY KEY)');
      await c.query('CREATE TABLE zz_child (id int PRIMARY KEY, parent_id int, CONSTRAINT zz_child_fk FOREIGN KEY (parent_id) REFERENCES zz_parent (id))');
      await c.query('GRANT DELETE ON zz_parent TO telesphoros_app');
      const before = (await c.query<{ fk: string }>(UNCOVERED_WITH_DELETABLE_PARENT)).rows.map((r) => r.fk);
      await c.query('CREATE INDEX zz_child_parent_idx ON zz_child (parent_id)');
      const after = (await c.query<{ fk: string }>(UNCOVERED_WITH_DELETABLE_PARENT)).rows.map((r) => r.fk);
      await c.query('DROP TABLE zz_child, zz_parent');
      return { before, after };
    });
    expect(found.before).toContain('zz_child_fk');
    expect(found.after).not.toContain('zz_child_fk');
  });
});
