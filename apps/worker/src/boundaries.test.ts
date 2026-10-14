import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level pins (M2.3a). Like the pins on `uploaded_at` and on evaluations, these read the code, because the rule they protect is "this can never be
 * done from here", and a behavioral test only proves it was not done in the cases it tried.
 */
const here = __dirname;
const importsOf = (file: string): string[] => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g), ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g), ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
};
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));

describe('what a job handler may import', () => {
  const handlers = sourceFiles(join(here, 'handlers'));
  it('has handlers to check', () => {
    expect(handlers.length).toBeGreaterThan(0);
  });
  it.each(handlers.map((h) => [h.slice(here.length + 1), h]))('%s reaches the database, the API and the clinical services through nothing', (_name, file) => {
    // Node built-ins, the job contract package, zod, and the worker's own types and the dependency interfaces it is handed (deps.ts): nothing else. In particular not
    // `pg`, not the AWS SDK, not the API, no repository, no service: a handler reaches data only through what it is given.
    const allowed = (spec: string) => spec.startsWith('node:') || spec === 'zod' || spec === '@telesphoros/jobs' || spec === '../runner' || spec === '../log' || spec === '../deps';
    for (const spec of importsOf(file as string)) expect(allowed(spec), `${spec} is not on the handler import allowlist`).toBe(true);
  });
  it('writes no SQL and names no clinical table', () => {
    for (const file of handlers) {
      // Comments may talk about reports; code may not name a table or run a statement.
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
      expect(source, file).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ledger_events|patients|reports|capture_acceptances|evaluations)\b/i);
    }
  });
});

describe('what the worker as a whole may import from the API', () => {
  it('takes exactly one file from the backend: the database TLS rule, which imports nothing from the application', () => {
    const fromBackend = new Set<string>();
    for (const file of sourceFiles(here)) for (const spec of importsOf(file)) if (/backend/.test(spec)) fromBackend.add(`${file.slice(here.length + 1)} -> ${spec}`);
    expect([...fromBackend].sort()).toEqual(['config.ts -> ../../backend/src/db/tls', 'main.ts -> ../../backend/src/db/tls']);
    const tlsImports = importsOf(resolve(here, '../../backend/src/db/tls.ts'));
    expect(tlsImports.every((s) => s.startsWith('node:'))).toBe(true);
  });
  it('is the only place that opens a database connection: handlers receive none', () => {
    const withPg = sourceFiles(here).filter((f) => importsOf(f).includes('pg')).map((f) => f.slice(here.length + 1));
    expect(withPg).toEqual(['main.ts']);
  });
  it('reads the bucket in one file only, with GET on a named version and no write command anywhere', () => {
    const withSdk = sourceFiles(here).filter((f) => importsOf(f).some((s) => s.startsWith('@aws-sdk/'))).map((f) => f.slice(here.length + 1)).sort();
    expect(withSdk).toEqual(['main.ts', 'storage.ts']);
    const storage = readFileSync(join(here, 'storage.ts'), 'utf8');
    expect(storage).toMatch(/GetObjectCommand/);
    expect(storage).not.toMatch(/\b(Put|Delete|Copy|Create|Restore|Upload)\w*Command\b/);
    expect(storage).toMatch(/VersionId/);
  });
});

describe('the API side', () => {
  const backend = resolve(here, '../../backend/src');
  it('never imports the worker (the dependency runs one way)', () => {
    for (const file of sourceFiles(backend)) for (const spec of importsOf(file)) expect(/apps\/worker|@telesphoros\/worker/.test(spec), `${file}: ${spec}`).toBe(false);
  });
  it('registers no test-only job type anywhere it could enqueue one', () => {
    for (const file of sourceFiles(backend)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/testOnly\s*:\s*true/);
  });
});
