// Tests for check-bundle-secrets.mjs. Every fixture below is assembled at run time from pieces, so no credential-shaped string sits in the
// repository for gitleaks to find; none of them is or was a real credential.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PATTERNS, scan } from './check-bundle-secrets.mjs';

const script = new URL('./check-bundle-secrets.mjs', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'bundle-secrets-'));
after(() => rmSync(box, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const x = (n, c = 'A') => c.repeat(n);
const bundle = (name, files) => {
  const dir = join(box, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};

// One sample per pattern, built from pieces. A pattern with no sample here would be untested, so the count is checked too.
const SAMPLES = {
  'AWS access key id': 'AK' + 'IA' + x(16, 'Q'),
  'private key': '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----',
  'GitHub token': 'gh' + 'p_' + x(36, 'b'),
  'Slack token': 'xo' + 'xb-' + x(12, '1'),
  'Anthropic API key': 'sk-' + 'ant-' + x(24, 'c'),
  'OpenAI or Stripe secret key': 'sk-' + 'proj-' + x(40, 'd'),
  'Google API key': 'AI' + 'za' + x(35, 'e'),
  'JSON Web Token': 'ey' + 'J' + x(12, 'f') + '.ey' + 'J' + x(12, 'g') + '.' + x(12, 'h'),
};

test('every pattern has a sample, and each sample is caught by its own pattern', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), PATTERNS.map(([kind]) => kind).sort());
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const dir = bundle(`one-${kind.replace(/\W+/g, '-')}`, { 'assets/index-abc.js': `const k=${JSON.stringify(sample)};` });
    assert.deepEqual(scan(dir), [{ file: join('assets', 'index-abc.js'), kind }], kind);
  }
});

test('a match exits 1 and names the file and the kind, never the text', () => {
  const dir = bundle('leaky', { 'index.html': '<html></html>', 'assets/index-abc.js': `fetch(u,{headers:{k:"${SAMPLES['AWS access key id']}"}})` });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /credential-shaped text in assets\/index-abc\.js: AWS access key id/);
  assert.ok(!r.stderr.includes(SAMPLES['AWS access key id']), 'the matched text is not printed');
});

test('a clean bundle passes, including library parameter names and public configuration (controls)', () => {
  const dir = bundle('clean', {
    'index.html': '<!doctype html><script type="module" src="/assets/index-abc.js"></script>',
    'assets/index-abc.js': 'const p={client_id:"design-preview",client_secret:void 0,authority:"https://idp.invalid"};const t="Bearer "+token;',
    'assets/index-abc.css': 'body{color:#000}',
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no credential-shaped text/);
});

test('refuses no argument, two arguments and a missing directory', () => {
  assert.equal(run().status, 2);
  assert.equal(run(box, box).status, 2);
  assert.equal(run(join(box, 'nope')).status, 2);
});
