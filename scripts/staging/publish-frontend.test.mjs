// Tests for scripts/staging/publish-frontend.sh (FD-7 slice 2). Imported by infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it.
// The script is run for real against a fixture build and a stand-in `aws` that records what it was asked to do: no credentials, no network, nothing uploaded.
// What this cannot prove: that the real AWS CLI accepts these arguments, that the bucket policy lets the person upload, or that the published site works.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const script = join(root, 'scripts/staging/publish-frontend.sh');
const sandbox = mkdtempSync(join(tmpdir(), 'publish-frontend-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const GOOD = {
  WEB_BUCKET: 'telesphoros-staging-web-123456789012',
  VITE_OIDC_AUTHORITY: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEfGhI',
  VITE_OIDC_CLIENT_ID: '1h57kf5cpq17m0eml12q8w3r',
  VITE_COGNITO_DOMAIN: 'https://telesphoros-staging.auth.us-east-2.amazoncognito.com',
  VITE_API_BASE_URL: 'https://api.staging.telesphoros.app',
  WEB_DISTRIBUTION_ID: 'E2ABCDEF123456',
};

/** A stand-in `aws`: appends its arguments to calls.log (and, for a sync or cp, the files it would send), and prints $STUB_LS for `s3 ls`. */
function stubDir() {
  const dir = mkdtempSync(join(sandbox, 'stub-'));
  writeFileSync(
    join(dir, 'aws'),
    `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
if [[ "$1 $2" == "s3 sync" ]]; then (cd "$3" && find . -type f | sort | sed 's/^/  sends /') >> "$STUB_LOG"; fi
if [[ "$1 $2" == "s3 ls" ]]; then printf '%s' "\${STUB_LS:-}"; fi
if [[ "$1 $2" == "sts get-caller-identity" ]]; then echo "123456789012 arn:aws:iam::123456789012:user/tester"; fi
exit 0
`,
  );
  chmodSync(join(dir, 'aws'), 0o755);
  return dir;
}

/** A build as `vite build` leaves it (with source maps, because vite.config.ts sets sourcemap: true). */
function fixtureBuild({ withSettings = true, extra = {} } = {}) {
  const dist = mkdtempSync(join(sandbox, 'dist-'));
  mkdirSync(join(dist, 'assets'));
  const settings = withSettings ? `const c={a:"${GOOD.VITE_API_BASE_URL}",o:"${GOOD.VITE_OIDC_AUTHORITY}"};` : 'const c={};';
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script>');
  writeFileSync(join(dist, 'assets/index-abc123.js'), `${settings}\n//# sourceMappingURL=index-abc123.js.map`);
  writeFileSync(join(dist, 'assets/index-abc123.js.map'), '{"version":3}');
  writeFileSync(join(dist, 'assets/style-def456.css'), 'body{margin:0}');
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
  mkdirSync(join(dist, '.vite')); // `manifest: true` in vite.config.ts writes this build-time file
  writeFileSync(join(dist, '.vite/manifest.json'), '{}');
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dist, name), text);
  return dist;
}

function run({ env = {}, args = [], dist = fixtureBuild(), scriptPath = script, ls = '' } = {}) {
  const stub = stubDir();
  const log = join(stub, 'calls.log');
  const result = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { PATH: `${stub}:${process.env.PATH}`, HOME: sandbox, STUB_LOG: log, STUB_LS: ls, DIST_DIR: dist, ...GOOD, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
}

/** An environment with one entry removed (an unset variable, which `{ ...GOOD, X: undefined }` would turn into the text "undefined"). */
function without(name) {
  const env = { ...GOOD };
  delete env[name];
  return env;
}
function runWithout(name) {
  const stub = stubDir();
  const result = spawnSync('bash', [script], { encoding: 'utf8', env: { PATH: `${stub}:${process.env.PATH}`, HOME: sandbox, STUB_LOG: join(stub, 'calls.log'), DIST_DIR: fixtureBuild(), ...without(name) } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('the default is a dry run: it validates, stages, says what it would do, and calls aws not at all', () => {
  const { status, out, calls } = run();
  assert.equal(status, 0, out);
  assert.match(out, /dry run: nothing uploaded/);
  assert.match(out, /4 files \(1 source maps left out\)/); // index.html, favicon.svg, one script, one stylesheet
  assert.match(out, /aws s3 cp .*index\.html/);
  assert.equal(calls, '', 'a dry run must not call aws');
});

test('--yes uploads in order: identity, hashed assets (immutable), the rest, index.html last, invalidation, then the source-map check', () => {
  const { status, out, calls } = run({ args: ['--yes'] });
  assert.equal(status, 0, out);
  const lines = calls.split('\n').filter((l) => l.startsWith('aws '));
  assert.deepEqual(
    lines.map((l) => l.split(' ').slice(1, 3).join(' ')),
    ['sts get-caller-identity', 's3 sync', 's3 sync', 's3 cp', 'cloudfront create-invalidation', 's3 ls'],
  );
  assert.match(lines[1], /\/assets s3:\/\/telesphoros-staging-web-123456789012\/assets --cache-control public,max-age=31536000,immutable/);
  assert.match(lines[2], /--exclude assets\/\* --exclude index\.html --cache-control no-cache/);
  assert.match(lines[3], /index\.html s3:\/\/telesphoros-staging-web-123456789012\/index\.html --cache-control no-cache --content-type text\/html/);
  assert.match(lines[4], /--distribution-id E2ABCDEF123456 --paths \/\*/);
  assert.doesNotMatch(calls, /--delete/, 'nothing is deleted: open tabs may still need old hashed assets');
  assert.doesNotMatch(calls, /sends .*\.map$/m, 'no source map is sent');
  assert.match(calls, /sends \.\/index-abc123\.js$/m);
  assert.doesNotMatch(calls, /sends .*\.vite/, 'the build manifest is not published');
});

test('no invalidation is requested without a distribution id', () => {
  const { status, calls } = run({ args: ['--yes'], env: { WEB_DISTRIBUTION_ID: '' } });
  assert.equal(status, 0);
  assert.doesNotMatch(calls, /cloudfront/);
});

test('a source map already in the bucket fails the run after the upload', () => {
  const { status, out } = run({ args: ['--yes'], ls: '2026-10-15 20:00:00 13 assets/old.js.map\n' });
  assert.notEqual(status, 0);
  assert.match(out, /a source map is in the bucket/);
});

test('each missing setting is refused', () => {
  for (const name of Object.keys(without('WEB_DISTRIBUTION_ID'))) {
    const { status, out } = runWithout(name);
    assert.notEqual(status, 0, `${name} unset must fail`);
    assert.match(out, new RegExp(`${name} is not set`));
  }
});

test('unsafe or placeholder settings are refused, each for its own reason', () => {
  const bad = [
    ['plain http authority', { VITE_OIDC_AUTHORITY: 'http://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEfGhI' }, /must be an https/],
    ['plain http API', { VITE_API_BASE_URL: 'http://api.staging.telesphoros.app' }, /must be an https/],
    ['plain http sign-in domain', { VITE_COGNITO_DOMAIN: 'http://telesphoros-staging.auth.us-east-2.amazoncognito.com' }, /must be an https/],
    ['the .env.example authority', { VITE_OIDC_AUTHORITY: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_XXXXXXXXX' }, /placeholder/],
    ['the .env.example sign-in domain', { VITE_COGNITO_DOMAIN: 'https://your-prefix.auth.us-east-2.amazoncognito.com' }, /placeholder/],
    ['an example host', { VITE_API_BASE_URL: 'https://api.example.com' }, /placeholder/],
    ['an angle-bracket template', { VITE_OIDC_CLIENT_ID: '<client id>' }, /placeholder|whitespace/],
    ['a client id with a space', { VITE_OIDC_CLIENT_ID: 'abc def' }, /whitespace/],
    ['localhost', { VITE_API_BASE_URL: 'https://localhost' }, /this machine/],
    ['a loopback address', { VITE_API_BASE_URL: 'https://127.0.0.1' }, /this machine/],
    ['a path on the API base (the app appends /api/v1)', { VITE_API_BASE_URL: 'https://api.staging.telesphoros.app/api/v1' }, /no path/],
    ['a trailing slash on the API base', { VITE_API_BASE_URL: 'https://api.staging.telesphoros.app/' }, /no path/],
    ['an s3:// bucket', { WEB_BUCKET: 's3://telesphoros-staging-web-123456789012' }, /not a bucket name/],
    ['an uppercase bucket', { WEB_BUCKET: 'Telesphoros' }, /not a bucket name/],
    ['a bad distribution id', { WEB_DISTRIBUTION_ID: 'd111111abcdef8.cloudfront.net' }, /not a CloudFront distribution id/],
    ['the local owned-storage build flag', { VITE_LOCAL_STORAGE_INTAKE: 'true' }, /must not reach the published bundle/],
    ['the end-to-end storage origins', { VITE_REPORT_STORAGE_ORIGINS: 'http://127.0.0.1:5557' }, /must not reach the published bundle/],
  ];
  for (const [name, env, pattern] of bad) {
    const { status, out, calls } = run({ env, args: ['--yes'] });
    assert.notEqual(status, 0, `must refuse: ${name}`);
    assert.match(out, pattern, `wrong reason for: ${name}`);
    assert.equal(calls, '', `nothing may be called for: ${name}`);
  }
  const { status, out } = run({ args: ['--force'] });
  assert.notEqual(status, 0);
  assert.match(out, /unknown argument/);
});

test('a build that was not made with these settings, or is not a build, is refused', () => {
  const stale = run({ dist: fixtureBuild({ withSettings: false }), args: ['--yes'] });
  assert.notEqual(stale.status, 0);
  assert.match(stale.out, /not built with these settings/);
  assert.equal(stale.calls, '');

  const hidden = run({ dist: fixtureBuild({ extra: { '.env': 'SECRET=1' } }), args: ['--yes'] });
  assert.notEqual(hidden.status, 0);
  assert.match(hidden.out, /hidden file/);

  const empty = mkdtempSync(join(sandbox, 'empty-'));
  const none = run({ dist: empty });
  assert.notEqual(none.status, 0);
  assert.match(none.out, /no index\.html/);
});

test('the source-map guard fires: with the exclusion removed the script refuses', () => {
  const text = readFileSync(script, 'utf8');
  const from = "find . -type f ! -name '*.map' ! -path './.vite/*' -print0";
  assert.ok(text.includes(from), 'the control must match the real script');
  const broken = join(sandbox, 'publish-frontend-broken.sh');
  writeFileSync(broken, text.replace(from, "find . -type f ! -path './.vite/*' -print0"));
  const { status, out, calls } = run({ scriptPath: broken, args: ['--yes'] });
  assert.notEqual(status, 0);
  assert.match(out, /a source map is in the upload set/);
  assert.equal(calls, '');
});

test('the build really does write source maps (so the exclusion is needed), and the settings the script validates are the ones the app requires', async () => {
  assert.match(readFileSync(join(root, 'apps/frontend/vite.config.ts'), 'utf8'), /sourcemap:\s*true/, 'if maps are ever turned off the exclusion stays as a second guard');
  const { loadAuthConfig, AuthConfigError } = await import(join(root, 'apps/frontend/src/auth/authConfig.ts'));
  const env = Object.fromEntries(Object.entries(GOOD).filter(([k]) => k.startsWith('VITE_')));
  assert.doesNotThrow(() => loadAuthConfig(env, 'https://app.staging.telesphoros.app', true), 'the accepted settings must start the application');
  assert.throws(() => loadAuthConfig({ ...env, VITE_API_BASE_URL: 'http://api.staging.telesphoros.app' }, 'https://app.staging.telesphoros.app', true), AuthConfigError);
  assert.equal(run({ env: { VITE_API_BASE_URL: 'http://api.staging.telesphoros.app' } }).status !== 0, true, 'what the application refuses the script refuses first');
});

test('web.tf exposes the distribution id, null while web hosting is off', () => {
  const web = readFileSync(join(root, 'infrastructure/terraform/web.tf'), 'utf8');
  assert.match(web, /output "web_distribution_id" \{[^}]*value\s*=\s*var\.enable_web_hosting \? aws_cloudfront_distribution\.web\[0\]\.id : null/s);
});
