// Run with: node --test .github/ci/e2e-storage.test.mjs   (pnpm test:ci-config)
// The nightly browser suite on PostgreSQL (.github/workflows/e2e-storage.yml) builds its database with scripts/e2e-storage/provision.sh, which repeats the
// "Memberships" procedure of docs/ops/local-storage-browser.md. Two copies of one list drift: a persona added to the document alone would pass by hand and
// fail every night, or the reverse. This pins the script's organizations and grants to the document's, and the workflow to the script.
// `provisionProblems` returns what is wrong with copies of the files (empty when nothing is); the controls run it on deliberately broken copies.
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { test } from 'node:test';

const url = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(url(p), 'utf8');
const real = {
  script: read('../../scripts/e2e-storage/provision.sh'),
  doc: read('../../docs/ops/local-storage-browser.md'),
  workflow: read('../workflows/e2e-storage.yml'),
};

/** The `grant <tenant> <sub> <roles>` lines (roles may be "") and `tenant create --id <id>` lines of a block of shell, normalised to a sorted list. */
export function memberships(text) {
  const grants = [...text.matchAll(/^grant[ \t]+(\S+)[ \t]+(\S+)[ \t]+(""|\S+)/gm)].map((m) => `grant ${m[1]} ${m[2]} ${m[3]}`);
  const tenants = [...text.matchAll(/^\$CLI tenant create --id (\S+)/gm)].map((m) => `tenant ${m[1]}`);
  return [...tenants, ...grants].sort();
}

export function provisionProblems({ script, doc, workflow }) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const fromScript = memberships(script);
  const fromDoc = memberships(doc);
  need(fromScript.length >= 9, `the script must create two organizations and grant the personas (found ${fromScript.length} lines)`);
  need(JSON.stringify(fromScript) === JSON.stringify(fromDoc), `the script and docs/ops/local-storage-browser.md must create the same organizations and grants\n  script only: ${fromScript.filter((l) => !fromDoc.includes(l)).join('; ') || '-'}\n  doc only: ${fromDoc.filter((l) => !fromScript.includes(l)).join('; ') || '-'}`);
  need(/^CREATE ROLE \$APP_LOGIN LOGIN [^\n]*\bNOSUPERUSER\b[^\n]*\bNOBYPASSRLS\b[^\n]* IN ROLE telesphoros_app;$/m.test(script), 'the CREATE ROLE statement must make the application login NOSUPERUSER, NOBYPASSRLS and a member of telesphoros_app (a mention in a comment does not count)');
  need(/\[ "\$COUNTS" = "7,2" \]/.test(script), 'the script must read the membership count back from the database');
  need(/scripts\/e2e-storage\/provision\.sh/.test(workflow), 'the workflow must run scripts/e2e-storage/provision.sh');
  need(/E2E_ENV_FILE="\$GITHUB_ENV"/.test(workflow), 'the workflow must take the database URL from the script through $GITHUB_ENV, never from its log');
  return problems;
}

test('the nightly provisioning script, the manual procedure and the workflow agree', () => {
  assert.ok(real.script.length > 500 && real.doc.length > 500 && real.workflow.length > 500, 'the files were read (a floor, so an empty read cannot pass)');
  assert.deepEqual(provisionProblems(real), []);
});

test('the provisioning script is executable', () => {
  accessSync(url('../../scripts/e2e-storage/provision.sh'), constants.X_OK);
});

test('the checks report each way the three could drift (controls)', () => {
  const weakened = [
    ['a persona only in the document', { doc: real.doc.replace('grant alpha 99999999-9999-4999-8999-999999999999 admin,reviewer', 'grant alpha 99999999-9999-4999-8999-999999999999 admin,reviewer\ngrant beta 55555555-5555-4555-8555-555555555555 reader') }],
    ['a persona only in the script', { script: real.script.replace('grant alpha 77777777-7777-4777-8777-777777777777 reviewer', 'grant alpha 77777777-7777-4777-8777-777777777777 reader') }],
    ['an organization missing from the script', { script: real.script.replace(/^\$CLI tenant create --id beta.*\n/m, '') }],
    ['a login that bypasses row-level security', { script: real.script.replace('NOCREATEROLE NOBYPASSRLS IN ROLE', 'NOCREATEROLE BYPASSRLS IN ROLE') }],
    ['a login that is a superuser', { script: real.script.replace('NOSUPERUSER NOCREATEDB', 'SUPERUSER NOCREATEDB') }],
    ['no read-back of the count', { script: real.script.replace('"7,2"', '"x"') }],
    ['the workflow stops running the script', { workflow: real.workflow.replace('scripts/e2e-storage/provision.sh', 'true') }],
    ['the workflow prints the URL', { workflow: real.workflow.replace('E2E_ENV_FILE="$GITHUB_ENV" ', '') }],
  ];
  for (const [name, change] of weakened) {
    const copy = { ...real, ...change };
    assert.ok(Object.keys(change).every((k) => copy[k] !== real[k]), `the control for "${name}" must change the real text (it does not: fix the control)`);
    assert.ok(provisionProblems(copy).length > 0, `a weakened copy must be reported: ${name}`);
  }
});
