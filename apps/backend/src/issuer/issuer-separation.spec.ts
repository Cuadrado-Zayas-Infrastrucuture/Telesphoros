import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_ROOT, importClosure, type ImportClosure, specifiersOf } from '../../test/helpers/import-closure';

/**
 * DATA-01 PR A, the separation test. The issuer's database login mints tenant capabilities; the application's login must never be in the same process. The
 * entry (`src/issuer/main.ts`) is therefore allowed to load a short, named list of files, and none of the modules that hold the application's pool, the
 * application's other secrets or the worker. The list is exact: a new import of anything else fails here and has to be argued for in review.
 *
 * Everything here is judged from the import statements in the sources, so it cannot see a `require` built from a string. The positive controls and the
 * mutants in this file show that the walk finds what it is meant to find.
 */
const ENTRY = 'src/issuer/main.ts';

/** Every local file the issuer entry may load. */
const ALLOWED_FILES = new Set([
  'src/issuer/main.ts',
  'src/issuer/issuer-app.ts',
  'src/issuer/issuer-env.ts',
  'src/issuer/issuer-log.ts',
  'src/issuer/issuer-server.ts',
  'src/issuer/issuer-core.ts',
  'src/issuer/capability-issuer.port.ts',
  'src/auth/cognito-token-verifier.ts',
  'src/auth/token-verifier.ts',
  'src/db/tls.ts',
]);

/** Packages it may load. `@telesphoros/jobs` is code only (token-verifier.ts takes `isSystemActor` from it); it holds no credential. */
const ALLOWED_PACKAGES = new Set(['@nestjs/common', '@telesphoros/jobs', '@telesphoros/shared-types', 'jose', 'pg', 'zod']);

/** Modules that must never be reachable, whatever else changes: the application's pool, its configuration, the worker, and the code that holds other logins. */
const FORBIDDEN: [RegExp, string][] = [
  [/^src\/db\/database\.ts$/, "the application's pool"],
  [/^src\/app\.module\.ts$/, 'the API module graph'],
  [/^src\/main\.ts$/, 'the API entry'],
  [/^src\/config\//, "the API's configuration (every application secret)"],
  [/^src\/db\/(provision-logins|cli|migrate|backup|restore)/, 'the operator tooling that holds the owner and migrator logins'],
  [/^src\/ledger\//, "the ledger verifier's login"],
  [/^src\/storage\//, 'the storage layer'],
  [/^src\/auth\/(auth\.guard|auth\.module|membership)/, 'the API authentication wiring'],
  [/^\.\.\/worker\//, 'the worker'],
  [/^\.\.\/\.\.\/packages\/jobs\//, 'the job queue sources'],
];

export function separationProblems(closure: ImportClosure): string[] {
  const problems: string[] = [];
  for (const file of closure.files) {
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(file)) problems.push(`${file} is reachable from the issuer entry: ${why}`);
    if (!ALLOWED_FILES.has(file)) problems.push(`${file} is not on the issuer's list of loadable files`);
  }
  for (const pkg of closure.packages) if (!pkg.startsWith('node:') && !ALLOWED_PACKAGES.has(pkg)) problems.push(`package ${pkg} is not on the issuer's list`);
  for (const miss of closure.unresolved) problems.push(`could not follow ${miss}`);
  return problems;
}

const read = (path: string) => readFileSync(join(BACKEND_ROOT, path), 'utf8');
/** The real sources, with `main.ts` replaced by `main` (a mutant). */
const withEntry = (main: string) => (path: string) => (path === ENTRY ? main : (() => { try { return read(path); } catch { return undefined; } })());

describe('the issuer entry loads only what it should', () => {
  it('has an entry, and the walk from it finds the whole chain (positive control: the core, the verifier and the TLS helper are reached)', () => {
    const closure = importClosure(ENTRY);
    for (const expected of ['src/issuer/issuer-core.ts', 'src/auth/cognito-token-verifier.ts', 'src/db/tls.ts', 'src/issuer/issuer-server.ts']) expect(closure.files).toContain(expected);
    expect(closure.packages).toContain('pg');
    expect(closure.packages).toContain('jose');
  });

  it('reaches no module that holds the application\'s pool, the worker or another credential, and nothing off the exact list', () => {
    expect(separationProblems(importClosure(ENTRY))).toEqual([]);
  });

  it('the list has no stale entries: every allowed file is really reached', () => {
    expect([...ALLOWED_FILES].filter((f) => !importClosure(ENTRY).files.has(f))).toEqual([]);
  });

  it('only main.ts reads process.env in the issuer\'s own sources; the rest are handed their settings', () => {
    const own = readdirSync(join(BACKEND_ROOT, 'src/issuer')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    expect(own).toContain('main.ts');
    for (const file of own) {
      const text = read(`src/issuer/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (file === 'main.ts') expect(text).toContain('process.env');
      else expect([file, /process\.env/.test(text)]).toEqual([file, false]);
    }
  });
});

describe('mutants: the test goes red when the entry reaches what it must not', () => {
  const real = read(ENTRY);
  const mutants: [string, string, RegExp][] = [
    ['the application pool', "import { Database } from '../db/database';", /database\.ts is reachable/],
    ['the API module', "import { AppModule } from '../app.module';", /app\.module\.ts is reachable/],
    ['the API configuration', "import { loadEnv } from '../config/env';", /config\/env\.ts is reachable/],
    ['the worker', "import { loadConfig } from '../../../worker/src/config';", /worker\/src\/config\.ts is reachable/],
    ['the ledger watch', "import { LedgerVerifier } from '../ledger/verifier';", /ledger\/verifier\.ts is reachable/],
    ['a new, unlisted file', "import { ping } from '../common/ping';", /not on the issuer's list/],
    ['a package off the list', "import { S3Client } from '@aws-sdk/client-s3';", /package @aws-sdk\/client-s3/],
    ['a require()', "const { Database } = require('../db/database');", /database\.ts is reachable/],
    ['a dynamic import()', "void import('../db/database');", /database\.ts is reachable/],
    ['a re-export', "export { Database } from '../db/database';", /database\.ts is reachable/],
  ];
  for (const [name, line, expected] of mutants) {
    it(`reports ${name}`, () => {
      const stubs = (path: string) => (path === 'src/common/ping.ts' ? 'export const ping = 1;\n' : undefined);
      const reader = (path: string) => withEntry(`${line}\n${real}`)(path) ?? stubs(path);
      const problems = separationProblems(importClosure(ENTRY, reader));
      expect(problems.some((p) => expected.test(p))).toBe(true);
      expect(separationProblems(importClosure(ENTRY, withEntry(real)))).toEqual([]); // control: the unmutated entry is clean
    });
  }

  it('a type-only import is not a load (the compiler removes it), but a mixed import is', () => {
    const typeOnly = `import type { Database } from '../db/database';\nimport type { Env } from '../config/env';\n${real}`;
    expect(separationProblems(importClosure(ENTRY, withEntry(typeOnly)))).toEqual([]);
    const mixed = `import { type Database, DATABASE_TOKEN } from '../db/database';\n${real}`;
    expect(separationProblems(importClosure(ENTRY, withEntry(mixed))).length).toBeGreaterThan(0);
  });

  it('the import reader sees every statement form', () => {
    const text = [
      "import a from 'pkg-a';", "import { b } from './local-b';", "import 'side-effect';", "export * from './local-c';", "export { d } from 'pkg-d';",
      "import {\n  e,\n  f,\n} from '../multi-line';", "const g = require('pkg-g');", "const h = await import('./dyn-h');", "import type { Skip } from './skip-type';",
      "// import { z } from './commented';", "/* import { y } from './block-commented'; */",
    ].join('\n');
    expect(specifiersOf(text).sort()).toEqual(['../multi-line', './dyn-h', './local-b', './local-c', 'pkg-a', 'pkg-d', 'pkg-g', 'side-effect']);
  });
});
