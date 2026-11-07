// A rehearsal against the REAL archive provider (spec 027 T022), not part of `pnpm test:infra`: it needs the pinned Terraform and the provider,
// so it is run by hand, offline, from a provider folder Terraform has already downloaded (the backend's data directory has one):
//   TERRAFORM=~/telesphoros-private/tools/terraform ARCHIVE_PROVIDER_MIRROR=~/telesphoros-private/maindata/providers \
//     node --test scripts/staging/release/lambda-build-rehearsal.test.mjs
// It proves what build_lambdas relies on: a rebuild that writes the same bytes makes the same zip hash whatever the file times, and a file's
// mode is part of the hash (the release scripts' umask 077 would change every bundle). It fails, not skips, when either is missing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const TF = process.env.TERRAFORM;
const MIRROR = process.env.ARCHIVE_PROVIDER_MIRROR;
const dir = mkdtempSync(join(tmpdir(), 'lambda-build-rehearsal-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, TF_DATA_DIR: join(dir, '.tf'), TF_CLI_CONFIG_FILE: join(dir, 'cli.tfrc'), TF_IN_AUTOMATION: '1' };
const tf = (...args) => spawnSync(TF, [`-chdir=${dir}`, ...args, '-no-color'], { encoding: 'utf8', env });
const hash = () => {
  rmSync(join(dir, 'out.zip'), { force: true });
  const a = tf('apply', '-input=false', '-auto-approve');
  assert.equal(a.status, 0, a.stderr);
  return tf('output', '-raw', 'h').stdout;
};

test('the archive provider hashes a bundle by its bytes and modes, not its file times', () => {
  assert.ok(TF && MIRROR, 'set TERRAFORM to the pinned 1.16.5 binary and ARCHIVE_PROVIDER_MIRROR to a providers folder');
  assert.match(spawnSync(TF, ['version'], { encoding: 'utf8' }).stdout, /^Terraform v1\.16\.5\b/);
  writeFileSync(join(dir, 'cli.tfrc'), `provider_installation {\n  filesystem_mirror { path = ${JSON.stringify(MIRROR)} }\n}\n`);
  writeFileSync(join(dir, 'main.tf'), [
    'terraform {\n  required_providers {\n    archive = { source = "hashicorp/archive" }\n  }\n}',
    'data "archive_file" "z" {\n  type        = "zip"\n  source_dir  = "${path.module}/dist"\n  output_path = "${path.module}/out.zip"\n}',
    'output "h" { value = data.archive_file.z.output_base64sha256 }\n',
  ].join('\n'));
  const init = tf('init', '-input=false');
  assert.equal(init.status, 0, init.stderr);
  const dist = join(dir, 'dist');
  const build = (mode, when) => {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.mjs'), 'export const handler = async () => 1;\n');
    chmodSync(join(dist, 'index.mjs'), mode);
    utimesSync(join(dist, 'index.mjs'), when, when);
  };
  build(0o644, new Date('2026-01-01T00:00:00Z'));
  const first = hash();
  build(0o644, new Date('2026-06-01T12:34:56Z'));
  assert.equal(hash(), first, 'the same bytes built later make the same zip hash');
  build(0o600, new Date('2026-01-01T00:00:00Z'));
  assert.notEqual(hash(), first, 'an owner-only file makes a different zip: the mode is in the zip');
});
