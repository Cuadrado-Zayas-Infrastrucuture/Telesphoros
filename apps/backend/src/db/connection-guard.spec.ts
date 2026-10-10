import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A new connection must not be able to bypass the TLS contract (db/tls.ts). Two rules over the application's non-test source:
 *   1. the words `connectionString` and `sslmode` appear nowhere except tls.ts (and `sslmode` in pg-process.ts, the libpq mapping) (a connection URL is only ever handed over through `pgClientConfig`);
 *   2. every `new Pool(...)` and `new Client(...)` is built from `pgClientConfig(...)`.
 * `connectionViolations` returns what is wrong with one file's text, so the rules are tested on text that must be flagged and on text that must pass.
 */
const SRC = join(__dirname, '..');

export function connectionViolations(file: string, text: string): string[] {
  const problems: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (!file.endsWith('db/tls.ts')) {
    if (/connectionString/.test(code)) problems.push(`${file}: names connectionString directly; use pgClientConfig(url)`);
    // pg-process.ts is the one mapping from DATABASE_SSL to libpq's PGSSLMODE for the command-line tools.
    if (/sslmode/i.test(code) && !file.endsWith('db/pg-process.ts')) problems.push(`${file}: reads or sets sslmode; TLS comes from DATABASE_SSL only (db/tls.ts)`);
  }
  const re = /new\s+(Pool|Client)\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    if (!code.slice(m.index, i).includes('pgClientConfig(')) problems.push(`${file}: new ${m[1]}(...) is not built from pgClientConfig(...)`);
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [path] : [];
  });
}

describe('every database connection goes through the TLS contract', () => {
  const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }));

  it('the scan found the application source (a floor, so an empty read cannot pass) including every known connection site', () => {
    expect(files.length).toBeGreaterThan(40);
    const constructing = files.filter((f) => /new\s+(Pool|Client)\s*\(/.test(f.text)).map((f) => f.file).sort();
    expect(constructing).toEqual(['db/backup.ts', 'db/cli.ts', 'db/database.ts', 'db/evidence-inventory.ts', 'db/provision-logins.ts', 'db/restore.ts', 'ledger/verifier.ts']);
  });

  it('no file bypasses pgClientConfig', () => {
    expect(files.flatMap((f) => connectionViolations(f.file, f.text))).toEqual([]);
  });

  it('flags each way a connection could bypass it (controls)', () => {
    const bad: Array<[string, string]> = [
      ['a bare connection string', "const c = new Client({ connectionString: url });"],
      ['a pool with an explicit ssl object and the URL', "const p = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true } });"],
      ['a pool built from other settings', "const p = new Pool({ host: 'h', max: 2 });"],
      ['reading sslmode', "const mode = new URL(u).searchParams.get('sslmode');"],
      ['a client built after a clean one on the same line', "const a = new Client(pgClientConfig(x)); const b = new Client({ host: 'h' });"],
    ];
    for (const [, text] of bad) expect(connectionViolations('x/y.ts', text).length).toBeGreaterThan(0);
    const good = [
      "const c = new Client(pgClientConfig(url));",
      "const p = new Pool({ ...pgClientConfig(url), max: 2 });",
      "// a comment may mention connectionString and sslmode\nconst c = new Client(pgClientConfig(url));",
      'const x = 1;',
    ];
    for (const text of good) expect(connectionViolations('x/y.ts', text)).toEqual([]);
    expect(connectionViolations('db/tls.ts', "const s = { connectionString: url }; // sslmode")).toEqual([]);
  });
});
