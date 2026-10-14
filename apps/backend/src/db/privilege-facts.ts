import type { Client } from 'pg';

/**
 * Who owns what, and who may do what, in the `public` schema: the part of a database that pg_dump records only if it is NOT told
 * `--no-owner`, and that matters more than any row. The ledger's guarantees rest on it (its SECURITY DEFINER functions run with
 * their OWNER's rights; a restore that hands them to a superuser would silently turn "the application can append" into "the
 * application runs code as a superuser"). Backups record these facts inside the backup's own snapshot; a restore recomputes and compares them.
 *
 * Every entry is a plain string so a comparison is a set comparison and a difference is readable:
 *   ownership   `table:patients|telesphoros_migrator`            `function:ledger_append(uuid,text,...)|telesphoros_ledger`
 *   grants      `table:ledger_events|telesphoros_app|SELECT`     `function:ledger_append(...)|PUBLIC|EXECUTE`   `column:event_notes.body|telesphoros_redactor|UPDATE`
 *   roles       every role named by an owner, a grant or a policy (they must exist on the server that restores the backup)
 */
export interface PrivilegeFacts {
  roles: string[];
  ownership: string[];
  grants: string[];
}

const NOT_EXTENSION = `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`;
const GRANTEE = `CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END`;

export async function readPrivilegeFacts(client: Client): Promise<PrivilegeFacts> {
  const column = async (sql: string): Promise<string[]> => (await client.query<{ v: string }>(sql)).rows.map((r) => r.v).sort();

  const ownership = await column(`
    SELECT 'table:' || c.relname || '|' || pg_get_userbyid(c.relowner) AS v FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'function:' || p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner) FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND ${NOT_EXTENSION}`);

  const grants = await column(`
    SELECT 'table:' || c.relname || '|' || ${GRANTEE} || '|' || a.privilege_type AS v FROM pg_class c, LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relacl IS NOT NULL
    UNION ALL
    SELECT 'column:' || c.relname || '.' || att.attname || '|' || ${GRANTEE} || '|' || a.privilege_type
      FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, LATERAL aclexplode(att.attacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND att.attacl IS NOT NULL AND NOT att.attisdropped
    UNION ALL
    SELECT 'function:' || p.oid::regprocedure::text || '|' || ${GRANTEE} || '|' || a.privilege_type FROM pg_proc p, LATERAL aclexplode(p.proacl) a
     WHERE p.pronamespace = 'public'::regnamespace AND p.proacl IS NOT NULL AND ${NOT_EXTENSION}
    UNION ALL
    -- A function with no explicit ACL carries the default: EXECUTE for everyone.
    SELECT 'function:' || p.oid::regprocedure::text || '|PUBLIC|EXECUTE' FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proacl IS NULL AND ${NOT_EXTENSION}
    UNION ALL
    SELECT 'schema:public|' || ${GRANTEE} || '|' || a.privilege_type FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspname = 'public'`);

  const policyRoles = await column(`SELECT DISTINCT unnest(roles)::text AS v FROM pg_policies WHERE schemaname = 'public'`);
  const named = new Set<string>(policyRoles);
  for (const entry of [...ownership, ...grants]) {
    const parts = entry.split('|');
    // `kind:object|role` (ownership) or `kind:object|role|privilege` (grants): the role is always the second field.
    if (parts[1]) named.add(parts[1]);
  }
  named.delete('PUBLIC');
  named.delete('public');
  return { roles: [...named].sort(), ownership, grants };
}

/** Human-readable differences between what a backup recorded and what a restored database has. Empty means identical. */
export function diffPrivilegeFacts(expected: PrivilegeFacts, actual: PrivilegeFacts): string[] {
  const problems: string[] = [];
  const compare = (label: string, want: string[], have: string[]) => {
    const wantSet = new Set(want);
    const haveSet = new Set(have);
    for (const entry of want) if (!haveSet.has(entry)) problems.push(`${label} missing after restore: ${entry}`);
    for (const entry of have) if (!wantSet.has(entry)) problems.push(`${label} not in the backup: ${entry}`);
  };
  compare('ownership', expected.ownership, actual.ownership);
  compare('privilege', expected.grants, actual.grants);
  return problems;
}

/**
 * Roles a backup needs on the restoring server when it carries no recorded privilege facts (made before they were recorded).
 * Derived from the migrations it contains; role names are the ones those migrations create.
 */
export function legacyRequiredRoles(migrations: string[]): string[] {
  const has = (version: string) => migrations.includes(version);
  const roles = new Set<string>();
  if (has('0002')) roles.add('telesphoros_app');
  if (has('0005')) ['telesphoros_ledger', 'telesphoros_ledger_verifier'].forEach((r) => roles.add(r));
  if (has('0006')) ['telesphoros_redactor', 'telesphoros_ledger_operator'].forEach((r) => roles.add(r));
  if (has('0018')) roles.add('telesphoros_security_auditor');
  return [...roles].sort();
}

/** The roles that are missing from the server, given the ones a restore needs. */
export async function missingRoles(client: Client, required: string[]): Promise<string[]> {
  if (required.length === 0) return [];
  const { rows } = await client.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`, [required]);
  const present = new Set(rows.map((r) => r.rolname));
  return required.filter((role) => !present.has(role));
}
