import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blankCommentsAndStrings, EXPAND_RULES, FIRST_LABELED_VERSION, GRANDFATHERED, lintMigration, lintMigrations } from './migration-lint';
import { loadMigrations } from './migrator';

const V = '0028';
// The setting rides on the first line of the SQL, so a statement keeps the line number it would have had without it. `plain*` leave it out.
const SETTING = "SET LOCAL lock_timeout = '2s'; ";
const expand = (sql: string) => `-- compat: expand\n${SETTING}${sql}`;
const breaking = (sql: string) => `-- compat: breaking\n${SETTING}${sql}`;
const plainExpand = (sql: string) => `-- compat: expand\n${sql}`;
const plainBreaking = (sql: string) => `-- compat: breaking\n${sql}`;

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
      // a breaking migration promises nothing about compatibility, but its lock_timeout use still cannot be read, so it is not passed in silence
      expect(lintMigration(V, breaking(sql)).join('\n')).toContain('lock_timeout use cannot be checked');
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

  // A migration that gives an EXISTING owner role the schema CREATE privilege for its own duration, and hands it back (0030, like 0028 for its own new role).
  // The REVOKE only restores what the earlier migrations already left: the role holds no CREATE, which they show by granting it and revoking it again.
  describe('handing back a CREATE the earlier migrations had already taken away from an existing role', () => {
    const handedBack = 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nCREATE TABLE y (id int);\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner;\n';
    const earlierEndedRevoked = 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nCREATE TABLE o (id int);\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner;\n';

    it('accepts it when the last earlier word on that privilege for that role was a REVOKE', () => {
      expect(lint(handedBack, earlierEndedRevoked)).toEqual([]);
      expect(lint(handedBack, `${earlierEndedRevoked}GRANT CREATE ON SCHEMA public TO telesphoros_other;\n`)).toEqual([]); // another role's grant is not this role's
      expect(lint(handedBack, `GRANT CREATE ON SCHEMA public TO telesphoros_owner, telesphoros_other;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner, telesphoros_other;\n`)).toEqual([]);
    });

    it.each([
      ['the earlier migrations left the role holding it (granted, never revoked)', handedBack, 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\n'],
      ['the earlier migrations granted it again after revoking it', handedBack, `${earlierEndedRevoked}GRANT CREATE ON SCHEMA public TO telesphoros_owner;\n`],
      ['the earlier migrations say nothing about the role', handedBack, 'CREATE TABLE o (id int);\n'],
      ['the earlier REVOKE was of a different privilege', handedBack, 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nREVOKE USAGE ON SCHEMA public FROM telesphoros_owner;\n'],
      ['the earlier REVOKE was from a different role', handedBack, 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_other;\n'],
      ['the earlier REVOKE was on a different schema', handedBack, 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nREVOKE CREATE ON SCHEMA private FROM telesphoros_owner;\n'],
      ['this file revokes without having granted it first', 'CREATE TABLE y (id int);\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner;\n', earlierEndedRevoked],
      ['this file grants a different privilege than it revokes', 'GRANT USAGE ON SCHEMA public TO telesphoros_owner;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner;\n', earlierEndedRevoked],
      ['this file revokes it from a second role it never granted it to', 'GRANT CREATE ON SCHEMA public TO telesphoros_owner;\nREVOKE CREATE ON SCHEMA public FROM telesphoros_owner, telesphoros_other;\n', earlierEndedRevoked],
    ])('still refuses it when %s', (_why, sql, earlier) => {
      const problems = lint(sql, earlier);
      expect(problems.join('\n')).toContain('REVOKE');
      expect(problems.join('\n')).toContain('Label it breaking');
    });
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

const LOCK = '';

describe('migration lint: a trigger or constraint added to an existing table', () => {
  // Each statement acts on `t`, which this file does not create. LOCK keeps the lock_timeout rule out of these cases.
  const added: Array<[string, string, string]> = [
    ['a trigger', 'CREATE TRIGGER g BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();', 'TRIGGER'],
    ['a constraint trigger', 'CREATE CONSTRAINT TRIGGER g AFTER INSERT ON t DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();', 'TRIGGER'],
    ['a CHECK constraint', 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);', 'CHECK'],
    ['an unnamed CHECK constraint', 'ALTER TABLE t ADD CHECK (a > 0);', 'CHECK'],
    ['a FOREIGN KEY', 'ALTER TABLE t ADD CONSTRAINT c FOREIGN KEY (a) REFERENCES u (id);', 'FOREIGN KEY'],
    ['a UNIQUE constraint', 'ALTER TABLE t ADD CONSTRAINT c UNIQUE (a);', 'UNIQUE'],
    ['a column that carries a reference', 'ALTER TABLE t ADD COLUMN a int REFERENCES u (id);', 'REFERENCES'],
    ['a column that carries a CHECK', 'ALTER TABLE t ADD COLUMN a int DEFAULT 1 CHECK (a > 0);', 'CHECK'],
    ['a unique index', 'CREATE UNIQUE INDEX i ON t (a);', 'UNIQUE'],
    ['an exclusion constraint', 'ALTER TABLE t ADD CONSTRAINT c EXCLUDE USING gist (a WITH =);', 'EXCLUDE'],
    ['a primary key', 'ALTER TABLE t ADD PRIMARY KEY (a);', 'PRIMARY KEY'],
  ];

  it.each(added)('refuses %s on an existing table in an expand migration, and accepts it labelled breaking', (_what, sql, mention) => {
    const problems = lintMigration(V, expand(`${LOCK}${sql}\n`));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('existing table t');
    expect(problems.join('\n')).toContain(mention);
    expect(problems.join('\n')).toContain('Label it breaking');
    expect(lintMigration(V, breaking(`${LOCK}${sql}\n`))).toEqual([]); // control
  });

  it('accepts the same statements on a table the same file creates (nothing older can be using it)', () => {
    for (const [, sql] of added) {
      const onNew = sql.replace(/\bt\b/g, 'fresh').replace(/\bu\b/g, 'fresh');
      expect(lintMigration(V, expand(`CREATE TABLE fresh (a int, id int);\n${onNew}\n`))).toEqual([]);
    }
  });

  it('accepts a table created with IF NOT EXISTS or a schema prefix, and refuses one created only AFTER the statement', () => {
    expect(lintMigration(V, expand('CREATE TABLE IF NOT EXISTS public.fresh (a int);\nCREATE TRIGGER g BEFORE UPDATE ON fresh FOR EACH ROW EXECUTE FUNCTION f();\n'))).toEqual([]);
    expect(lintMigration(V, expand(`${LOCK}CREATE TRIGGER g BEFORE UPDATE ON fresh FOR EACH ROW EXECUTE FUNCTION f();\nCREATE TABLE fresh (a int);\n`)).length).toBeGreaterThan(0);
  });

  it('still allows what is additive: a plain index, a new nullable column, an enabled policy on a new role', () => {
    expect(lintMigration(V, expand(`${LOCK}CREATE INDEX i ON t (a);\nALTER TABLE t ADD COLUMN b int;\n`))).toEqual([]);
  });

  it('does not read a trigger or constraint inside a comment, a string or a function body', () => {
    expect(lintMigration(V, expand(`${LOCK}-- CREATE TRIGGER g BEFORE UPDATE ON t\nSELECT 'ALTER TABLE t ADD CHECK (a > 0)';\n`))).toEqual([]);
    expect(lintMigration(V, expand("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'x'; PERFORM 1; END $$;\n"))).toEqual([]);
  });

  it('reports the line of the statement', () => {
    const problems = lintMigration(V, expand(`${LOCK}SELECT 1;\nSELECT 2;\nALTER TABLE t ADD CHECK (a > 0);\n`));
    expect(problems.join('\n')).toMatch(/line 4\b/); // 1 is the label, 2 the setting and SELECT 1
  });
});

describe('migration lint: DDL on an existing table must set lock_timeout first', () => {
  const ddl: Array<[string, string]> = [
    ['ALTER TABLE', 'ALTER TABLE t ADD COLUMN a int;'],
    ['ENABLE ROW LEVEL SECURITY', 'ALTER TABLE t ENABLE ROW LEVEL SECURITY;'],
    ['CREATE INDEX', 'CREATE INDEX i ON t (a);'],
    ['CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX i ON t (a);'],
    ['CREATE TRIGGER', 'CREATE TRIGGER g BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();'],
    ['DROP TRIGGER', 'DROP TRIGGER IF EXISTS g ON t;'],
    ['CREATE POLICY', 'CREATE POLICY p ON t FOR SELECT TO r USING (true);'],
    ['DROP POLICY', 'DROP POLICY p ON t;'],
  ];
  const lockProblems = (up: string) => lintMigration(V, up).filter((p) => p.includes('lock_timeout'));

  it.each(ddl)('%s: refused without lock_timeout, accepted after SET LOCAL lock_timeout', (_what, sql) => {
    const refused = lockProblems(plainBreaking(`${sql}\n`));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('existing table t');
    expect(lintMigration(V, breaking(`${sql}\n`))).toEqual([]); // control: the same statement with the setting
  });

  it('applies to an expand migration too', () => {
    expect(lockProblems(plainExpand('ALTER TABLE t ADD COLUMN a int;\n'))).toHaveLength(1);
    expect(lintMigration(V, expand('ALTER TABLE t ADD COLUMN a int;\n'))).toEqual([]);
  });

  it('wants it BEFORE the statement, and a real value', () => {
    expect(lockProblems(plainBreaking(`CREATE INDEX i ON t (a);\nSET LOCAL lock_timeout = '2s';\n`))).toHaveLength(1);
    for (const setting of ["SET LOCAL lock_timeout = '0';", 'SET LOCAL lock_timeout = 0;', "SET LOCAL lock_timeout = '0ms';", 'SET LOCAL lock_timeout TO DEFAULT;']) {
      expect(lockProblems(plainBreaking(`${setting}\nCREATE INDEX i ON t (a);\n`))).toHaveLength(1);
    }
    for (const setting of ["SET lock_timeout = '2s';", "SET SESSION lock_timeout TO '500ms';", 'SET LOCAL lock_timeout TO 2000;', "set local lock_timeout='3s';"]) {
      expect(lintMigration(V, plainBreaking(`${setting}\nCREATE INDEX i ON t (a);\n`))).toEqual([]);
    }
  });

  it('a later SET 0 turns it off again for what follows', () => {
    expect(lockProblems(plainBreaking("SET LOCAL lock_timeout = '2s';\nSET LOCAL lock_timeout = 0;\nCREATE INDEX i ON t (a);\n"))).toHaveLength(1);
  });

  it("does not take a function's own SET lock_timeout, or one in a comment or string, for the session setting", () => {
    const fn = "CREATE FUNCTION f() RETURNS void LANGUAGE sql SET lock_timeout = '2s' AS $$ SELECT 1 $$;\n";
    expect(lockProblems(plainBreaking(`${fn}CREATE INDEX i ON t (a);\n`))).toHaveLength(1);
    expect(lockProblems(plainBreaking("-- SET LOCAL lock_timeout = '2s';\nSELECT 'SET LOCAL lock_timeout = 1';\nCREATE INDEX i ON t (a);\n"))).toHaveLength(1);
  });

  it('needs none for a table the file creates, or when the file only creates functions and grants', () => {
    expect(lintMigration(V, plainBreaking('CREATE TABLE fresh (a int);\nCREATE INDEX i ON fresh (a);\nALTER TABLE fresh ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON fresh FOR SELECT TO r USING (true);\n'))).toEqual([]);
    expect(lintMigration(V, plainExpand('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nGRANT EXECUTE ON FUNCTION f() TO r;\n'))).toEqual([]);
  });

  it('names the statement and its line, once per statement', () => {
    const problems = lockProblems(plainBreaking('SELECT 1;\nCREATE INDEX i ON t (a);\nALTER TABLE u ADD COLUMN b int;\n'));
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/line 3\b/);
    expect(problems.join('\n')).toMatch(/line 4\b/);
  });

  it('is not applied before the label existed (those migrations are not checked at all)', () => {
    expect(lintMigration('0027', 'CREATE INDEX i ON t (a);')).toEqual([]);
  });

  it('does not read the body of a function as a statement the migration runs', () => {
    const body = 'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; CREATE INDEX i ON t (a); ALTER TABLE t ADD CHECK (a > 0); END $$;\n';
    expect(lintMigration(V, plainBreaking(body))).toEqual([]);
    expect(lintMigration(V, plainExpand(body))).toEqual([]);
    expect(lockProblems(plainBreaking('CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $tag$ SELECT 1 $tag$;\nCREATE INDEX i ON t (a);\n'))).toHaveLength(1); // and the statement after it is still read
  });

  it('does not see DDL that is run from inside a function body or a DO block (a stated limit, so the next test is its control)', () => {
    expect(lintMigration(V, plainBreaking("DO $$ BEGIN EXECUTE 'CREATE INDEX i ON t (a)'; END $$;\n"))).toEqual([]);
    expect(lintMigration(V, plainBreaking("DO $$ BEGIN CREATE INDEX i ON t (a); END $$;\n"))).toEqual([]);
  });
});

describe('migration lint: migrations that predate the rules, by number', () => {
  const real = loadMigrations();
  const ungrandfathered = (version: string) => {
    const m = real.find((x) => x.version === version)!;
    const earlier = real.filter((x) => x.version < version).map((x) => x.upSql).join('\n');
    return lintMigration(version, m.upSql, { earlier, grandfathered: {} });
  };

  it('lists only migrations that exist, and each entry names the rules it excuses and why', () => {
    for (const [version, entry] of Object.entries(GRANDFATHERED)) {
      expect(real.map((m) => m.version)).toContain(version);
      expect(entry.rules.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  it('is live: without its entry each listed migration really is reported for exactly the rules it excuses', () => {
    for (const [version, entry] of Object.entries(GRANDFATHERED)) {
      const found = ungrandfathered(version).join('\n');
      expect(found.length).toBeGreaterThan(0);
      for (const rule of entry.rules) expect(found).toContain(rule === 'expand-adds-constraint-or-trigger' ? 'Label it breaking' : 'lock_timeout');
    }
  });

  it('excuses only that number: the same text under a later number is reported', () => {
    for (const [version] of Object.entries(GRANDFATHERED)) {
      const m = real.find((x) => x.version === version)!;
      expect(lintMigration('9999', m.upSql, { earlier: '' }).length).toBeGreaterThan(0);
    }
  });

  it('passes every migration that ships, with the list in force (control)', () => {
    expect(lintMigrations()).toEqual([]);
  });
});
