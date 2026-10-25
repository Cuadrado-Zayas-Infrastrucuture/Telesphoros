import { expectRecordTablePolicies, type CatalogPolicy } from './helpers/catalog-policy-assertions';

const table = 'report_captures';
const tenant = 'tenant_id = (SELECT public.app_tenant())';
const policies: CatalogPolicy[] = [
  { tablename: table, policyname: 'report_captures_tenant', roles: ['telesphoros_app'], cmd: 'ALL', qual: tenant, with_check: tenant },
  { tablename: table, policyname: 'report_captures_ledger', roles: ['telesphoros_ledger'], cmd: 'SELECT', qual: tenant, with_check: null },
  { tablename: table, policyname: 'report_captures_verifier', roles: ['telesphoros_ledger_verifier'], cmd: 'SELECT', qual: 'true', with_check: null },
];
const fresh = (): CatalogPolicy[] => structuredClone(policies);

describe('record-table catalog policy assertions', () => {
  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])('accepts valid policies in order %s, %s, %s', (a, b, c) => {
    expect(() => expectRecordTablePolicies(table, [policies[a]!, policies[b]!, policies[c]!])).not.toThrow();
  });

  it('finds an exact role anywhere in a multi-role policy array', () => {
    const rows = fresh();
    rows[1]!.roles = ['unrelated_role', 'telesphoros_ledger'];
    expect(() => expectRecordTablePolicies(table, rows)).not.toThrow();
  });

  it('does not let unrelated tables satisfy a missing policy', () => {
    const rows = fresh();
    rows[1]!.tablename = 'other_table';
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it('rejects a missing ledger policy even when the verifier role remains', () => {
    expect(() => expectRecordTablePolicies(table, [policies[0]!, policies[2]!])).toThrow();
  });

  it.each([
    [0, 'telesphoros_app_reader'],
    [1, 'telesphoros_ledger_operator'],
    [2, 'telesphoros_ledger_verifier_extra'],
  ])('rejects role prefix collisions at policy %s: %s', (index, role) => {
    const rows = fresh();
    rows[index]!.roles = [role];
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it('rejects multiple policies for the same exact ledger role', () => {
    const duplicate = { ...policies[1]!, policyname: 'unexpected_extra_ledger' };
    expect(() => expectRecordTablePolicies(table, [...policies, duplicate])).toThrow();
  });

  it.each(['qual', 'with_check'] as const)('still rejects a broadened application %s', (field) => {
    const rows = fresh();
    rows[0]![field] = 'true';
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it('still rejects a broadened ledger predicate', () => {
    const rows = fresh();
    rows[1]!.qual = 'true';
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it.each([1, 2])('still rejects non-SELECT command on read policy %s', (index) => {
    const rows = fresh();
    rows[index]!.cmd = 'ALL';
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });
});

describe('record-table catalog policy review regression controls', () => {
  it.each([0, 1, 2])('refuses absent exact role at row %s', (index) => {
    const rows = fresh();
    rows.splice(index, 1);
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it.each([0, 1, 2])('refuses duplicate exact role at row %s', (index) => {
    const rows = fresh();
    rows.push({ ...rows[index]!, policyname: 'extra' });
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it.each([0, 1, 2])('refuses an empty role array at row %s', (index) => {
    const rows = fresh();
    rows[index]!.roles = [];
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it.each([0, 1])('refuses null tenant qual at row %s', (index) => {
    const rows = fresh();
    rows[index]!.qual = null;
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it('refuses null application WITH CHECK', () => {
    const rows = fresh();
    rows[0]!.with_check = null;
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it.each([false, true])('refuses valid/broadened duplicate ledger policies, reversed=%s', (reverse) => {
    const rows = fresh();
    rows.push({ ...rows[1]!, policyname: 'broad', qual: 'true' });
    if (reverse) rows.reverse();
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });

  it('accepts prefix-colliding nonmatching names alongside the exact role', () => {
    const rows = fresh();
    rows[1]!.roles = ['telesphoros_ledger_verifier_extra', 'telesphoros_ledger_operator', 'telesphoros_ledger'];
    expect(() => expectRecordTablePolicies(table, rows)).not.toThrow();
  });

  it('uses case-sensitive exact role equality', () => {
    const rows = fresh();
    rows[1]!.roles = ['TELESPHOROS_LEDGER'];
    expect(() => expectRecordTablePolicies(table, rows)).toThrow();
  });
});
