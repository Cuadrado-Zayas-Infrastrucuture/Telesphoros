import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blankCommentsAndStrings, EXPAND_RULES, FIRST_LABELED_VERSION, lintMigration, lintMigrations } from './migration-lint';
import { loadMigrations } from './migrator';

const V = '0028';
const expand = (sql: string) => `-- compat: expand\n${sql}`;
const breaking = (sql: string) => `-- compat: breaking\n${sql}`;

const created: string[] = [];
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A migrations directory with 0001..0027 as one-line fillers, then the given 0028 up file. */
function directoryWith(up: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-lint-'));
  created.push(dir);
  for (let n = 1; n <= 27; n += 1) {
    const v = String(n).padStart(4, '0');
    writeFileSync(join(dir, `${v}_filler.up.sql`), 'SELECT 1;\n');
    writeFileSync(join(dir, `${v}_filler.down.sql`), 'SELECT 1;\n');
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0028_under_test.up.sql'), up);
  writeFileSync(join(dir, '0028_under_test.down.sql'), 'SELECT 1;\n');
  return dir;
}

describe('migration lint: scope', () => {
  it('passes every migration that ships', () => {
    expect(lintMigrations()).toEqual([]);
  });

  it('starts at the first migration after the label existed, and the shipped set still ends before it', () => {
    expect(FIRST_LABELED_VERSION).toBe(28);
    // If a shipped migration at or after FIRST_LABELED_VERSION appears, the test above is what checks it; this pins the boundary.
    const shipped = loadMigrations().map((m) => Number(m.version));
    expect(shipped.filter((n) => n < FIRST_LABELED_VERSION)).toHaveLength(27);
  });

  it('does not check migrations from before the label (they are unlabelled and count as breaking)', () => {
    expect(lintMigration('0027', 'DROP TABLE x;')).toEqual([]);
    expect(lintMigration('0001', 'ALTER TABLE t RENAME TO u;')).toEqual([]);
  });

  it('requires an explicit label from 0028 on', () => {
    expect(lintMigration(V, 'CREATE TABLE t (id int);\n').join('\n')).toContain('add `-- compat: expand` or `-- compat: breaking`');
    expect(lintMigration(V, breaking('CREATE TABLE t (id int);\n'))).toEqual([]);
    expect(lintMigration(V, expand('CREATE TABLE t (id int);\n'))).toEqual([]);
  });

  it('says so when the label is outside the leading comment block, because the migrator ignores it there', () => {
    const problems = lintMigration(V, 'CREATE TABLE t (id int);\n-- compat: expand\n');
    expect(problems.join('\n')).toContain('not in the leading comment block');
  });

  it('surfaces an unknown or doubled label from the migrator instead of guessing', () => {
    expect(lintMigration(V, '-- compat: expnad\nSELECT 1;\n').join('\n')).toContain('unknown compat label');
    expect(lintMigration(V, '-- compat: expand\n-- compat: breaking\nSELECT 1;\n').join('\n')).toContain('more than one compat label');
  });
});

describe('migration lint: what an expand migration may not contain', () => {
  const forbidden: Array<[string, string, string]> = [
    ['drop', 'DROP TABLE old_things;', 'DROP'],
    ['drop', 'ALTER TABLE t DROP COLUMN c;', 'DROP'],
    ['drop', 'ALTER TABLE t DROP CONSTRAINT c;', 'DROP'],
    ['drop', 'DROP POLICY IF EXISTS p ON t;', 'DROP'],
    ['rename', 'ALTER TABLE t RENAME COLUMN a TO b;', 'RENAME'],
    ['rename', 'ALTER TABLE t RENAME TO u;', 'RENAME'],
    ['alter-column-type', 'ALTER TABLE t ALTER COLUMN a TYPE bigint;', 'ALTER COLUMN'],
    ['alter-column-type', 'ALTER TABLE t ALTER COLUMN a SET DATA TYPE text;', 'ALTER COLUMN'],
    ['set-not-null', 'ALTER TABLE t ALTER COLUMN a SET NOT NULL;', 'SET NOT NULL'],
    ['revoke', 'REVOKE SELECT ON t FROM telesphoros_app;', 'REVOKE'],
    ['truncate', 'TRUNCATE t;', 'TRUNCATE'],
    ['create-or-replace', 'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', 'CREATE OR REPLACE'],
    ['create-or-replace', 'CREATE OR REPLACE VIEW v AS SELECT 1;', 'CREATE OR REPLACE'],
  ];

  it('has a test case for every rule', () => {
    expect([...new Set(forbidden.map(([id]) => id))].sort()).toEqual(EXPAND_RULES.map((r) => r.id).sort());
  });

  it.each(forbidden)('%s: refuses `%s` in an expand migration, and accepts the same SQL labelled breaking', (_id, sql, mention) => {
    const problems = lintMigration(V, expand(`${sql}\n`));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(mention);
    expect(problems.join('\n')).toContain('Label it breaking');
    expect(lintMigration(V, breaking(`${sql}\n`))).toEqual([]); // control
  });

  it('refuses a constraint dropped and added back, which is how a constraint is widened', () => {
    const sql = 'ALTER TABLE t DROP CONSTRAINT t_check;\nALTER TABLE t ADD CONSTRAINT t_check CHECK (a IN (1, 2));\n';
    expect(lintMigration(V, expand(sql)).join('\n')).toContain('DROP');
  });

  it.each([
    'CREATE TABLE t (id int PRIMARY KEY, a text NOT NULL);',
    'ALTER TABLE t ADD COLUMN a text;',
    'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text;',
    'ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0;',
    'ALTER TABLE t ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY NOT NULL;',
    'CREATE INDEX t_a_idx ON t (a);',
    'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    'GRANT SELECT ON t TO telesphoros_app;',
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NOT NULL);',
  ])('accepts the additive statement `%s` in an expand migration', (sql) => {
    expect(lintMigration(V, expand(`${sql}\n`))).toEqual([]);
  });

  it('refuses ADD COLUMN ... NOT NULL with no default, naming the column line only', () => {
    const sql = 'ALTER TABLE t\n  ADD COLUMN ok int NOT NULL DEFAULT 1,\n  ADD COLUMN bad int NOT NULL;\n';
    const problems = lintMigration(V, expand(sql));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 4'); // the label line is line 1
    expect(problems[0]).toContain('NOT NULL column with no default');
    expect(lintMigration(V, breaking(sql))).toEqual([]);
  });

  it('reports the line of the offending statement', () => {
    const problems = lintMigration(V, expand('CREATE TABLE a (id int);\n\n-- note\nDROP TABLE b;\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 5');
  });

  it('is not case sensitive and tolerates odd whitespace', () => {
    expect(lintMigration(V, expand('alter table t\n   alter   column a\n  set   not   null;\n')).length).toBeGreaterThan(0);
    expect(lintMigration(V, expand('Drop\nTable x;\n')).length).toBeGreaterThan(0);
  });
});

describe('migration lint: comments, strings and unreadable files', () => {
  it('does not mistake comments, strings or quoted names for statements', () => {
    const sql = [
      '-- DROP TABLE old;',
      '/* RENAME TO x; REVOKE ALL */',
      "COMMENT ON TABLE t IS 'we never drop or TRUNCATE this; it''s CREATE OR REPLACE-safe';",
      'ALTER TABLE t ADD COLUMN "drop" text;',
      "INSERT INTO t (a) VALUES ('SET NOT NULL');",
      '',
    ].join('\n');
    expect(lintMigration(V, expand(sql))).toEqual([]);
    // control: the same words as statements are refused
    expect(lintMigration(V, expand('DROP TABLE old;\n')).length).toBeGreaterThan(0);
  });

  it('refuses, rather than passes, a file that ends inside a quote or comment, because a stray quote would hide what follows', () => {
    for (const sql of ["SELECT 'unterminated;\nDROP TABLE x;\n", 'SELECT "unterminated;\nDROP TABLE x;\n', '/* never closed\nDROP TABLE x;\n']) {
      const problems = lintMigration(V, expand(sql));
      expect(problems.join('\n')).toContain('could not read the SQL safely');
      expect(lintMigration(V, breaking(sql))).toEqual([]); // a breaking migration promises nothing, so nothing is checked
    }
    const input = "a 'b' -- c\n/* d\ne */ f";
    const blanked = blankCommentsAndStrings(input)!;
    expect(blanked).toHaveLength(input.length); // same length, so line numbers still match
    expect(blanked).toMatch(/^a\s+\n\s+\n\s+f$/); // only the code survives; the newlines stay
    expect(blankCommentsAndStrings("'x")).toBeUndefined();
  });
});

describe('migration lint: over a migrations directory', () => {
  it('flags an unlabelled 0028 and an expand 0028 that drops something, and passes honest ones', () => {
    expect(lintMigrations(directoryWith('CREATE TABLE t (id int);\n')).join('\n')).toContain('Migration 0028: add `-- compat');
    expect(lintMigrations(directoryWith(expand('DROP TABLE t;\n'))).join('\n')).toContain('Migration 0028: labelled expand but line 2 uses DROP');
    expect(lintMigrations(directoryWith(breaking('DROP TABLE t;\n')))).toEqual([]);
    expect(lintMigrations(directoryWith(expand('CREATE TABLE t (id int);\n')))).toEqual([]);
  });
});

describe('migration lint: a REVOKE that only undoes what the same migration created', () => {
  // `earlier` is the SQL of the migrations before this one. Without it the lint cannot know an object is new, so it exempts nothing.
  const newFunction = 'CREATE FUNCTION f_new(p text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n';
  const newRole = "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_newrole') THEN\n  CREATE ROLE telesphoros_newrole NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nEND IF; END $$;\n";
  const lint = (sql: string, earlier = 'CREATE TABLE t (id int);\n') => lintMigration(V, expand(sql), { earlier });

  it('accepts revoking the default PUBLIC privilege on a function this migration creates', () => {
    expect(lint(`${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM PUBLIC;\n`)).toEqual([]);
    expect(lint(`${newFunction}REVOKE EXECUTE ON FUNCTION public.f_new(text) FROM PUBLIC;\n`)).toEqual([]);
  });

  it('accepts revoking a privilege this migration granted to a role this migration introduces', () => {
    const sql = `${newRole}GRANT CREATE ON SCHEMA public TO telesphoros_newrole;\nCREATE TABLE x (id int);\nREVOKE CREATE ON SCHEMA public FROM telesphoros_newrole;\n`;
    expect(lint(sql)).toEqual([]);
  });

  // Positive controls: the same shapes, each with the one fact that makes the REVOKE remove something older code may rely on.
  it.each([
    ['the function already existed before this migration', `${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM PUBLIC;\n`, 'CREATE FUNCTION f_new(p text) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;\n'],
    ['the function is not created in this migration', 'REVOKE ALL ON FUNCTION f_old(text) FROM PUBLIC;\n', undefined],
    ['the revoke is from a role, not PUBLIC', `${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM telesphoros_app;\n`, undefined],
    ['one object in the list is older', `${newFunction}REVOKE ALL ON FUNCTION f_new(text), f_old() FROM PUBLIC;\n`, undefined],
    ['a table that already existed', 'REVOKE SELECT ON t FROM PUBLIC;\n', undefined],
    ['the grant comes after the revoke', `${newRole}REVOKE CREATE ON SCHEMA public FROM telesphoros_newrole;\nGRANT CREATE ON SCHEMA public TO telesphoros_newrole;\n`, undefined],
    ['a different privilege was granted', `${newRole}GRANT USAGE ON SCHEMA public TO telesphoros_newrole;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_newrole;\n`, undefined],
    ['the role is not introduced by this migration', 'GRANT CREATE ON SCHEMA public TO telesphoros_app;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_app;\n', undefined],
    ['the role already appears in an earlier migration', `${newRole}GRANT CREATE ON SCHEMA public TO telesphoros_newrole;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_newrole;\n`, 'GRANT SELECT ON t TO telesphoros_newrole;\n'],
    ['a role membership', `${newRole}GRANT telesphoros_newrole TO telesphoros_app;\nREVOKE telesphoros_newrole FROM telesphoros_app;\n`, undefined],
  ])('still refuses it when %s', (_why, sql, earlier) => {
    const problems = lint(sql, earlier);
    expect(problems.join('\n')).toContain('REVOKE');
    expect(problems.join('\n')).toContain('Label it breaking');
  });

  it('exempts nothing when it is not told what came before (the safe default)', () => {
    const sql = expand(`${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM PUBLIC;\n`);
    expect(lintMigration(V, sql).join('\n')).toContain('REVOKE');
    expect(lintMigration(V, sql, { earlier: '' })).toEqual([]); // control: told that nothing came before, it is exempt
  });

  it('reports a later REVOKE that is not exempt even after an exempt one', () => {
    const problems = lint(`${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM PUBLIC;\nREVOKE SELECT ON t FROM telesphoros_app;\n`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 4');
  });

  it('over a directory, knows what the earlier migrations created', () => {
    expect(lintMigrations(directoryWith(expand(`${newFunction}REVOKE ALL ON FUNCTION f_new(text) FROM PUBLIC;\n`)))).toEqual([]);
    expect(lintMigrations(directoryWith(expand('REVOKE ALL ON FUNCTION f_filler() FROM PUBLIC;\n'))).join('\n')).toContain('REVOKE');
  });
});
