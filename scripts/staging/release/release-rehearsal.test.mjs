// A rehearsal against REAL Terraform (spec 027 T009), not part of `pnpm test:infra`: it needs the pinned binary, so it is run by hand:
//   TERRAFORM=~/telesphoros-private/tools/terraform node --test scripts/staging/release/release-rehearsal.test.mjs
// Two saved plans are made from the same state; the first is applied; Terraform itself must then refuse the second. The release scripts refuse
// it earlier (release-scripts.test.mjs), from the serial in its record; this proves the second line of defence exists, with a local backend
// and the built-in terraform_data resource, so no provider and no cloud are involved. It fails, not skips, when the binary is missing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const TF = process.env.TERRAFORM;
const dir = mkdtempSync(join(tmpdir(), 'release-rehearsal-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tf = (...args) => spawnSync(TF, [`-chdir=${dir}`, ...args, '-no-color'], { encoding: 'utf8', env: { ...process.env, TF_DATA_DIR: join(dir, '.tf'), TF_IN_AUTOMATION: '1' } });
const serial = () => JSON.parse(readFileSync(join(dir, 'terraform.tfstate'), 'utf8')).serial;

test('Terraform 1.16.5 refuses a saved plan made before another apply', () => {
  assert.ok(TF, 'set TERRAFORM to the pinned 1.16.5 binary');
  assert.match(spawnSync(TF, ['version'], { encoding: 'utf8' }).stdout, /^Terraform v1\.16\.5\b/);
  writeFileSync(join(dir, 'main.tf'), 'variable "v" {}\nresource "terraform_data" "x" { input = var.v }\n');
  assert.equal(tf('init', '-input=false').status, 0);
  assert.equal(tf('apply', '-input=false', '-auto-approve', '-var', 'v=0').status, 0, 'the starting state');
  const start = serial();
  assert.equal(tf('plan', '-input=false', '-var', 'v=1', '-out=a.tfplan').status, 0);
  assert.equal(tf('plan', '-input=false', '-var', 'v=2', '-out=b.tfplan').status, 0);
  const a = tf('apply', '-input=false', 'a.tfplan');
  assert.equal(a.status, 0, a.stderr);
  assert.ok(serial() > start, `the apply moved the serial (${start} -> ${serial()})`);
  const b = tf('apply', '-input=false', 'b.tfplan');
  assert.notEqual(b.status, 0, 'the second saved plan applied: Terraform did not refuse it');
  assert.match(b.stderr + b.stdout, /Saved plan is stale/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'terraform.tfstate'), 'utf8')).resources[0].instances[0].attributes.input.value, '1', 'the state still holds the first plan');
});
