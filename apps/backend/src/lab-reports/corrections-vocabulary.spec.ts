import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORRECTION_KINDS, REASONS_FOR_KIND } from '@telesphoros/shared-types';

// The frozen vocabulary of specification 4.2 lives in two places: the API's request schema (so a bad request is a clear 400) and a CHECK
// constraint in migration 0009 (so nothing can be stored that the table forbids). They must say the same thing, or a request would pass
// one and fail the other with an unhelpful conflict. This reads the migration text, so it needs no database.
describe('the correction vocabulary in the API and in migration 0009', () => {
  const sql = readFileSync(join(__dirname, '../../migrations/0009_corrections_and_disputes.up.sql'), 'utf8');
  const constraint = sql.slice(sql.indexOf('CONSTRAINT corrections_reason_for_kind'), sql.indexOf('CONSTRAINT corrections_replacement CHECK'));

  /** `kind = 'x' AND reason_code IN ('a', 'b')` or `kind = 'x' AND reason_code = 'a'` -> { x: [a, b] } */
  const fromSql = (): Record<string, string[]> => {
    const found: Record<string, string[]> = {};
    for (const match of constraint.matchAll(/kind = '([a-z]+)'\s+AND reason_code (?:IN \(([^)]*)\)|= '([^']+)')/g)) {
      found[match[1]!] = (match[2] ?? `'${match[3]}'`).split(',').map((code) => code.trim().replace(/'/g, ''));
    }
    return found;
  };

  it('finds all three kinds in the migration (a floor, so an unreadable constraint cannot pass as "equal")', () => {
    expect(Object.keys(fromSql()).sort()).toEqual([...CORRECTION_KINDS].sort());
    expect(Object.values(fromSql()).flat().length).toBeGreaterThanOrEqual(11);
  });

  it('allows exactly the same reasons for each kind', () => {
    const database = fromSql();
    for (const kind of CORRECTION_KINDS) expect({ kind, reasons: [...database[kind]!].sort() }).toEqual({ kind, reasons: [...REASONS_FOR_KIND[kind]].sort() });
  });
});
