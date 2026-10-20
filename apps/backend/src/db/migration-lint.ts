import { type Compat, loadMigrations, MIGRATIONS_DIR, parseCompat } from './migrator';

/**
 * Checks that a migration's `-- compat:` label is honest. The label is a promise to readiness: `expand` lets tasks running an
 * older image stay ready after the migration is applied, so a wrongly labelled migration would leave them ready but failing.
 *
 * Migration 0027 and earlier predate the label (unlabelled counts as `breaking`) and are not checked. From 0028 on every
 * migration must say which it is, and an `expand` migration may not contain the statements below.
 *
 * This is a guard against the obvious mistakes, not a proof of compatibility. It does not look at `ADD CONSTRAINT`, unique
 * indexes, data rewrites or row-level-security policy changes, any of which can still break older code: label those `breaking`.
 */
export const FIRST_LABELED_VERSION = 28;

interface ExpandRule {
  id: string;
  pattern: RegExp;
  why: string;
}

/** Statements an `expand` migration may not contain. Matched on the SQL with comments and string literals blanked out. */
export const EXPAND_RULES: readonly ExpandRule[] = [
  { id: 'drop', pattern: /\bDROP\b/i, why: 'removes something older code may still use' },
  { id: 'rename', pattern: /\bRENAME\b/i, why: 'older code still uses the old name' },
  { id: 'alter-column-type', pattern: /\bALTER\s+COLUMN\b[^;]*?\bTYPE\b/i, why: 'changes the type older code reads and writes' },
  { id: 'set-not-null', pattern: /\bSET\s+NOT\s+NULL\b/i, why: 'older code may still write NULL' },
  { id: 'revoke', pattern: /\bREVOKE\b/i, why: 'removes a privilege older code may rely on' },
  { id: 'truncate', pattern: /\bTRUNCATE\b/i, why: 'removes data older code may still read' },
  { id: 'create-or-replace', pattern: /\bCREATE\s+OR\s+REPLACE\b/i, why: 'changes behaviour that older code may call' },
];

const NOT_A_COLUMN = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'EXCLUDE']);

/**
 * Replaces comments, quoted strings and quoted identifiers with spaces, keeping every newline so line numbers still match.
 * Returns undefined when the file ends inside one of them: a stray quote would otherwise hide everything after it, so the
 * caller must treat the file as unreadable rather than as clean.
 */
export function blankCommentsAndStrings(sql: string): string | undefined {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const ch = sql[i]!;
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      out += blank(sql.slice(i, end + 2));
      i = end + 2;
    } else if (ch === "'" || ch === '"') {
      // A doubled quote ('it''s') needs no special case: it reads as two adjacent strings, and both are blanked.
      const end = sql.indexOf(ch, i + 1);
      if (end === -1) return undefined;
      out += blank(sql.slice(i, end + 1));
      i = end + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** ADD COLUMN ... NOT NULL with no default: an older INSERT that omits the column would fail. */
function addColumnNotNullWithoutDefault(code: string): number[] {
  const lines: number[] = [];
  const addColumn = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)\s+([^,;]*)/gi;
  for (const match of code.matchAll(addColumn)) {
    const name = match[1]!.replace(/"/g, '').toUpperCase();
    if (NOT_A_COLUMN.has(name)) continue;
    const definition = match[2]!;
    if (/\bNOT\s+NULL\b/i.test(definition) && !/\b(DEFAULT|GENERATED|SERIAL|BIGSERIAL)\b/i.test(definition)) lines.push(lineOf(code, match.index!));
  }
  return lines;
}

export interface LintContext {
  /** The `.up.sql` of every earlier migration. Without it the lint cannot tell a new object from an old one, so it exempts no REVOKE. */
  earlier?: string;
}

interface PrivilegeStatement {
  privileges: string;
  kind: string;
  objects: string[];
  roles: string[];
}

/** Splits on commas that are not inside parentheses (a function list carries argument lists). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const objectName = (text: string) => text.replace(/\(.*$/s, '').trim().toLowerCase().replace(/^public\./, '');

/** `GRANT`/`REVOKE <privileges> ON [kind] <objects> TO|FROM <roles>`; undefined for a role membership or anything it cannot read. */
function parsePrivilegeStatement(body: string, direction: 'TO' | 'FROM'): PrivilegeStatement | undefined {
  const match = new RegExp(`^\\s*(?:GRANT\\s+OPTION\\s+FOR\\s+)?(.+?)\\s+ON\\s+(?:(FUNCTION|TABLE|SCHEMA|SEQUENCE)\\s+)?(.+?)\\s+${direction}\\s+(.+?)\\s*(?:CASCADE|RESTRICT)?\\s*$`, 'is').exec(body);
  if (!match) return undefined;
  const privileges = splitTopLevel(match[1]!.replace(/\bPRIVILEGES\b/i, '')).map((p) => p.replace(/\s+/g, ' ').toUpperCase()).sort().join(',');
  const objects = splitTopLevel(match[3]!).map(objectName);
  if (objects.some((o) => !/^[a-z_][a-z0-9_]*$/.test(o))) return undefined; // ALL TABLES IN SCHEMA, a quoted name: not something to exempt
  const roles = splitTopLevel(match[4]!.replace(/\bWITH\s+GRANT\s+OPTION\b/i, '')).map((r) => r.toLowerCase());
  return { privileges, kind: (match[2] ?? 'TABLE').toUpperCase(), objects, roles };
}

/**
 * Positions of the REVOKE statements that only undo what this same migration created, so they cannot take anything from older code:
 *   - the default PUBLIC privilege on a FUNCTION or TABLE that this file creates (with CREATE, not CREATE OR REPLACE) and no earlier migration names; or
 *   - the exact reverse of a GRANT made earlier in this file, to roles this file creates and no earlier migration names.
 * Matched on blanked SQL (strings and comments removed); anything it cannot read is not exempt.
 */
function undoingRevokes(code: string, earlierSql: string | undefined): Set<number> {
  const exempt = new Set<number>();
  if (earlierSql === undefined) return exempt;
  const earlier = blankCommentsAndStrings(earlierSql);
  if (earlier === undefined) return exempt;
  const namedEarlier = (name: string) => new RegExp(`\\b${name}\\b`, 'i').test(earlier);
  const createdBefore = (pattern: RegExp, index: number) =>
    new Set([...code.slice(0, index).matchAll(pattern)].map((m) => m[1]!.toLowerCase().replace(/^public\./, '')));
  const grants: Array<{ index: number; statement: PrivilegeStatement }> = [];
  for (const m of code.matchAll(/\bGRANT\b([^;]*)/gi)) {
    const statement = parsePrivilegeStatement(m[1]!, 'TO');
    if (statement) grants.push({ index: m.index!, statement });
  }
  for (const m of code.matchAll(/\bREVOKE\b([^;]*)/gi)) {
    const revoke = parsePrivilegeStatement(m[1]!, 'FROM');
    if (!revoke) continue;
    const at = m.index!;
    const functions = createdBefore(/\bCREATE\s+FUNCTION\s+((?:public\.)?[a-z_][a-z0-9_]*)\s*\(/gi, at);
    const tables = createdBefore(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:public\.)?[a-z_][a-z0-9_]*)/gi, at);
    const roles = createdBefore(/\bCREATE\s+ROLE\s+([a-z_][a-z0-9_]*)/gi, at);
    const created = revoke.kind === 'FUNCTION' ? functions : revoke.kind === 'TABLE' ? tables : new Set<string>();
    const defaultPrivilege = revoke.roles.length === 1 && revoke.roles[0] === 'public'
      && revoke.objects.every((o) => created.has(o) && !namedEarlier(o));
    const reversesGrant = revoke.roles.every((r) => roles.has(r) && !namedEarlier(r))
      && grants.some(({ index, statement }) => index < at && statement.kind === revoke.kind && statement.privileges === revoke.privileges
        && JSON.stringify([...statement.objects].sort()) === JSON.stringify([...revoke.objects].sort())
        && revoke.roles.every((r) => statement.roles.includes(r)));
    if (defaultPrivilege || reversesGrant) exempt.add(at);
  }
  return exempt;
}

/**
 * Problems with one migration's `.up.sql`, empty when it is fine. Applies only from FIRST_LABELED_VERSION; earlier ones return [].
 */
export function lintMigration(version: string, upSql: string, context: LintContext = {}): string[] {
  if (Number(version) < FIRST_LABELED_VERSION) return [];
  const problems: string[] = [];
  const say = (message: string) => problems.push(`Migration ${version}: ${message}`);

  let compat: Compat;
  try {
    compat = parseCompat(version, upSql);
  } catch (error) {
    return [(error as Error).message];
  }

  // `parseCompat` answers `breaking` both for a `breaking` label and for no label. Prepending an `expand` label tells them
  // apart without a second reader of the header: it throws ("more than one") exactly when the file already carries a label.
  let labelled = false;
  try {
    parseCompat(version, `-- compat: expand\n${upSql}`);
  } catch {
    labelled = true;
  }
  if (!labelled) {
    const stray = /^[ \t]*--[ \t]*compat:/m.test(upSql);
    say(
      stray
        ? 'the compat label is not in the leading comment block, so it is ignored. Move it above the first statement.'
        : 'add `-- compat: expand` or `-- compat: breaking` in the leading comment block (breaking if you are unsure).',
    );
    return problems;
  }
  if (compat !== 'expand') return problems;

  const code = blankCommentsAndStrings(upSql);
  if (code === undefined) {
    say('could not read the SQL safely (an unterminated quote or comment), so it cannot be accepted as expand. Fix the quote or label it breaking.');
    return problems;
  }
  const undoing = undoingRevokes(code, context.earlier);
  for (const rule of EXPAND_RULES) {
    // A REVOKE that only undoes what this migration created is skipped; the first one that is not is reported.
    const match = rule.id === 'revoke'
      ? [...code.matchAll(new RegExp(rule.pattern.source, 'gi'))].find((m) => !undoing.has(m.index!))
      : rule.pattern.exec(code);
    if (match) say(`labelled expand but line ${lineOf(code, match.index!)} uses ${match[0].replace(/\s+/g, ' ').toUpperCase()}, which ${rule.why}. Label it breaking.`);
  }
  for (const line of addColumnNotNullWithoutDefault(code)) {
    say(`labelled expand but line ${line} adds a NOT NULL column with no default, so an older INSERT that omits it would fail. Add a default or label it breaking.`);
  }
  return problems;
}

/** Lints every migration in a directory (the shipped ones by default). */
export function lintMigrations(dir: string = MIGRATIONS_DIR): string[] {
  const migrations = loadMigrations(dir);
  return migrations.flatMap((migration, i) =>
    lintMigration(migration.version, migration.upSql, { earlier: migrations.slice(0, i).map((m) => m.upSql).join('\n') }));
}
