export interface CatalogPolicy {
  tablename: string;
  policyname: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

/** Shared by the real catalog guard and its order/prefix regression controls. */
export function expectRecordTablePolicies(table: string, policies: readonly CatalogPolicy[]): void {
  const own = policies.filter((p) => p.tablename === table);
  const forRole = (role: string): CatalogPolicy => {
    // PostgreSQL returns an array: membership must never become a substring search.
    const matches = own.filter((p) => p.roles.includes(role));
    expect({ table, role, count: matches.length }).toEqual({ table, role, count: 1 });
    return matches[0]!;
  };
  const app = forRole('telesphoros_app');
  expect([table, app.qual, app.with_check]).toEqual([
    table, expect.stringContaining('app_tenant()'), expect.stringContaining('app_tenant()'),
  ]);
  const verifier = forRole('telesphoros_ledger_verifier');
  expect([table, verifier.cmd]).toEqual([table, 'SELECT']);
  // Forced RLS also applies to owners; ledger functions require their own tenant read policy.
  const ledger = forRole('telesphoros_ledger');
  expect([table, ledger.cmd, ledger.qual]).toEqual([table, 'SELECT', expect.stringContaining('app_tenant()')]);
}
