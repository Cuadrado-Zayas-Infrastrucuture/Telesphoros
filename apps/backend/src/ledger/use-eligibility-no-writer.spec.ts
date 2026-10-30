import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Spec 020 E1b, T207: the five use-eligibility records have NO writer in the product. The operator command (E2) and the grants API (E3) are later slices, and
// until they exist nothing may insert into these tables or call the policy: no controller, route, service, repository, worker, CLI or script. Tests and seed
// fixtures (test/, *.spec.ts) write them. This reads every source file of the repository outside tests and migrations, so a new file that mentions one of the
// names fails here and the change has to say why. The three files that REGISTER the tables with the ledger are the only ones allowed.
const ROOT = resolve(__dirname, '../../../..');
const NAMES = /\b(use_grants|use_grant_validations|use_withdrawals|use_restrictions|tenant_use_terms|use_eligibility|use_eligibility_lock)\b/;
const REGISTRATION = new Set(['apps/backend/src/db/append-only-tables.ts', 'apps/backend/src/ledger/ledger-types.ts', 'apps/backend/src/ledger/projections.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.git', '.turbo', 'test', 'tests', 'migrations', 'docs', 'specs', 'data', 'knowledge']);
const SOURCE = /\.(ts|tsx|js|cjs|mjs|sh|sql|ya?ml|json)$/;
const TEST_FILE = /\.(spec|e2e-spec|pg-spec|test)\.[cm]?[jt]sx?$/;

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry) && !TEST_FILE.test(entry)) yield path;
  }
}

describe('the use-eligibility records have no writer outside tests (T207)', () => {
  const files = ['apps', 'packages', 'scripts', 'infrastructure', 'sidecars', 'ml'].flatMap((top) => {
    try {
      return [...sources(join(ROOT, top))];
    } catch {
      return [];
    }
  });

  it('reads a real tree (control: the scan covers the backend and the worker)', () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain('apps/backend/src/ledger/ledger-types.ts');
    expect(rel.some((f) => f.startsWith('apps/worker/'))).toBe(true);
    expect(rel.length).toBeGreaterThan(200);
  });

  it('finds no mention of these tables or of the policy function in any source file but the three ledger registrations', () => {
    const mentions = files.map((f) => relative(ROOT, f)).filter((f) => NAMES.test(readFileSync(join(ROOT, f), 'utf8')) && !REGISTRATION.has(f));
    expect(mentions).toEqual([]);
  });

  it('the registrations themselves do mention them (control: the pattern can match)', () => {
    for (const f of REGISTRATION) expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(NAMES);
  });

  it('no controller or route file exists for them', () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel.filter((f) => /use-(grant|withdrawal|restriction|eligibility)|tenant-use-terms/.test(f))).toEqual([]);
  });
});
