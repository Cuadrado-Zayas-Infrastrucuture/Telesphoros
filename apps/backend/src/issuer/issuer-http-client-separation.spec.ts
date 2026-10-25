import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_ROOT, importClosure, type ImportClosure } from '../../test/helpers/import-closure';

/**
 * DATA-01 PR B, the API side of the separation. The issuer is a second process with its own database login precisely so that the API cannot mint a
 * capability. The API's client for it may therefore load the issuer's PORT (the interface and the error types) and nothing else of the issuer's: not the core,
 * the store, the server, the entry, the settings loader, nor the API's own pool or settings (the client takes its address as an argument and reads no
 * environment). The list is exact; a new import fails here and has to be argued for in review.
 *
 * Judged from the import statements, like issuer-separation.spec.ts, which also explains what that cannot see. The mutants below show the walk finds
 * what it is meant to find.
 */
const CLIENT = 'src/issuer/issuer-http-client.ts';

const ALLOWED_FILES = new Set([CLIENT, 'src/issuer/capability-issuer.port.ts']);
const ALLOWED_PACKAGES = new Set(['@nestjs/common', 'zod']);

/** What the API must never reach through this module, with the reason. */
const FORBIDDEN: [RegExp, string][] = [
  [/^src\/issuer\/(issuer-core|issuer-server|issuer-app|issuer-env|issuer-log|main)\.ts$/, "the issuer's own implementation"],
  [/^src\/issuer\/.*store/, "the issuer's store (the only code that calls the minting function)"],
  [/^src\/db\//, "a database module: the issuer's login is not the API's, and the client needs neither"],
  [/^src\/config\//, "the API's settings (the client is handed its address)"],
  [/^src\/auth\/cognito-token-verifier\.ts$/, "the verifier the issuer uses to read a person's token"],
];

export function clientSeparationProblems(closure: ImportClosure): string[] {
  const problems: string[] = [];
  for (const file of closure.files) {
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(file)) problems.push(`${file} is reachable from the issuer client: ${why}`);
    if (!ALLOWED_FILES.has(file)) problems.push(`${file} is not on the issuer client's list of loadable files`);
  }
  for (const pkg of closure.packages) if (!pkg.startsWith('node:') && !ALLOWED_PACKAGES.has(pkg)) problems.push(`package ${pkg} is not on the issuer client's list`);
  for (const miss of closure.unresolved) problems.push(`could not follow ${miss}`);
  return problems;
}

const read = (path: string) => {
  try {
    return readFileSync(join(BACKEND_ROOT, path), 'utf8');
  } catch {
    return undefined;
  }
};
const withClient = (client: string) => (path: string) => (path === CLIENT ? client : read(path));

describe('the issuer client loads only the port', () => {
  it('has a client file, and the walk finds the port from it (positive control)', () => {
    const closure = importClosure(CLIENT);
    expect(closure.files).toContain(CLIENT);
    expect(closure.files).toContain('src/issuer/capability-issuer.port.ts');
    expect(closure.packages).toContain('zod');
  });

  it('reaches no module of the issuer but the port, no database or settings module, and nothing off the exact list', () => {
    expect(clientSeparationProblems(importClosure(CLIENT))).toEqual([]);
  });

  it('the list has no stale entries: every allowed file is really reached', () => {
    expect([...ALLOWED_FILES].filter((f) => !importClosure(CLIENT).files.has(f))).toEqual([]);
  });

  it('reads no environment: it is handed its address', () => {
    const text = (read(CLIENT) ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(text.length).toBeGreaterThan(0);
    expect(/process\.env/.test(text)).toBe(false);
  });
});

describe('mutants: the test goes red when the client reaches what it must not', () => {
  const real = read(CLIENT) ?? '';
  const mutants: [string, string, RegExp][] = [
    ['the issuer core', "import { IssuerCore } from './issuer-core';", /issuer-core\.ts is reachable/],
    ["the issuer's store (through the core)", "import { PgCapabilityIssueStore } from './issuer-core';", /issuer-core\.ts is reachable/],
    ['the issuer server', "import { createIssuerServer } from './issuer-server';", /issuer-server\.ts is reachable/],
    ['the issuer entry', "import './main';", /issuer\/main\.ts is reachable/],
    ['the issuer settings', "import { loadIssuerEnv } from './issuer-env';", /issuer-env\.ts is reachable/],
    ['the application pool', "import { Database } from '../db/database';", /database\.ts is reachable/],
    ['the API settings', "import { loadEnv } from '../config/env';", /config\/env\.ts is reachable/],
    ['the token verifier', "import { CognitoTokenVerifier } from '../auth/cognito-token-verifier';", /cognito-token-verifier\.ts is reachable/],
    ['a package off the list', "import { Pool } from 'pg';", /package pg is not on the issuer client's list/],
    ['a require()', "const { Database } = require('../db/database');", /database\.ts is reachable/],
    ['a dynamic import()', "void import('./issuer-core');", /issuer-core\.ts is reachable/],
    ['a re-export', "export { IssuerCore } from './issuer-core';", /issuer-core\.ts is reachable/],
  ];
  for (const [name, line, expected] of mutants) {
    it(`reports ${name}`, () => {
      const problems = clientSeparationProblems(importClosure(CLIENT, withClient(`${line}\n${real}`)));
      expect(problems.some((p) => expected.test(p))).toBe(true);
      expect(clientSeparationProblems(importClosure(CLIENT, withClient(real)))).toEqual([]); // control: the unmutated client is clean
    });
  }

  it('a type-only import is not a load (the compiler removes it), but a mixed import is', () => {
    const typeOnly = `import type { IssuerCore } from './issuer-core';\n${real}`;
    expect(clientSeparationProblems(importClosure(CLIENT, withClient(typeOnly)))).toEqual([]);
    const mixed = `import { type IssuerCore, CORE_TOKEN } from './issuer-core';\n${real}`;
    expect(clientSeparationProblems(importClosure(CLIENT, withClient(mixed))).length).toBeGreaterThan(0);
  });
});
