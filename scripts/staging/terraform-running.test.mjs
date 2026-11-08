// Tests for scripts/staging/terraform-running.sh, the check behind release/lib.sh gate_quiet and staging-status.sh's plan row. Imported by
// infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it. A stand-in `pgrep` prints the command lines a test names, so no test
// here depends on what else runs on the machine; the last test reads the real `pgrep`, narrowed to a process this file starts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const check = join(root, 'scripts/staging/terraform-running.sh');
const lib = join(root, 'scripts/staging/release/lib.sh');
const box = mkdtempSync(join(tmpdir(), 'terraform-running-'));
after(() => rmSync(box, { recursive: true, force: true }));
const bin = join(box, 'bin');
mkdirSync(bin);
const write = (path, body) => { writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`); chmodSync(path, 0o755); };
// pgrep exits 1 and prints nothing when no process matches; otherwise it prints `PID command line`, one per process. The lines come from a
// file, since a test below lists more than an environment variable can hold.
const listed = join(box, 'pgrep-lines');
const asked = join(box, 'pgrep-args');
write(join(bin, 'pgrep'), `printf '%s\\n' "$@" > "${asked}"\n[ -s "${listed}" ] || exit 1\ncat "${listed}"`);

const bash = (code, lines, env = {}) => {
  writeFileSync(listed, lines.length ? `${lines.join('\n')}\n` : '');
  return spawnSync('bash', ['-c', code], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: box, TMPDIR: box, ...env } });
};
const running = (...lines) => {
  const r = bash(`set -euo pipefail; . "${check}"; if terraform_running; then echo running; else echo quiet; fi`, lines);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === 'running';
};

const REAL = [
  '4242 /opt/homebrew/bin/terraform -chdir=/x/infrastructure/terraform plan -input=false -out=a.tfplan',
  '4242 terraform apply a.tfplan',
  '4242 /Users/someone/.tfenv/versions/1.16.5/terraform import aws_s3_bucket.b name',
  '4242 /usr/local/bin/terraform untaint aws_instance.a',
  '4242 docker run --rm hashicorp/terraform:1.16.5 plan',
];
const STUBS = [
  '4242 bash /tmp/staging-status-sh-x/bin/terraform -chdir=/tmp/clone/infrastructure/terraform plan -input=false',
  '4242 /bin/bash /tmp/release-after-y/bin/terraform apply -input=false a.tfplan',
  '4242 /opt/homebrew/bin/bash /tmp/z/bin/terraform import a b',
  '4242 /usr/bin/env bash /tmp/z/bin/terraform plan',
  '4242 sh -c terraform plan',
  '4242 /bin/zsh -c terraform apply',
  '4242 -bash -c terraform plan',
  '4242 dash /tmp/z/bin/terraform untaint a',
];

test('it asks pgrep for whole command lines matching a plan, apply, import or untaint, the pattern the gate has always used', () => {
  running();
  assert.deepEqual(readFileSync(asked, 'utf8').split('\n').filter(Boolean), ['-fl', 'terraform.*(apply|plan|import|untaint)']);
});

test('a real Terraform plan, apply, import or untaint is running: from its own path, a bare name, a tfenv version, or docker', () => {
  for (const line of REAL) assert.equal(running(line), true, line);
});

test('a shell running a stand-in terraform is not Terraform running: bash, sh, zsh, dash, a login shell, through env', () => {
  for (const line of STUBS) assert.equal(running(line), false, line);
});

test('one real run among stand-ins still counts, in any order, and nothing matching is quiet', () => {
  assert.equal(running(STUBS[0], REAL[0], STUBS[1]), true);
  assert.equal(running(REAL[1], ...STUBS), true);
  assert.equal(running(...STUBS, REAL[2]), true);
  assert.equal(running(), false);
});

test('only a shell is ignored, not a command whose name ends in "sh"', () => {
  for (const line of ['4242 /usr/local/bin/push terraform plan', '4242 /opt/x/flash terraform apply', '4242 bashful terraform plan', '4242 /opt/x/ssh terraform plan']) {
    assert.equal(running(line), true, line);
  }
});

test('a real run listed first among many lines is still seen under pipefail: the output is read whole, never cut short', () => {
  // Far more than a pipe buffer after the real line: a filter that stopped at its first match would leave the writer to die of SIGPIPE.
  const many = Array.from({ length: 20000 }, (_, i) => `${5000 + i} bash /tmp/s/bin/terraform -chdir=/tmp/clone plan -input=false`);
  assert.equal(running(REAL[0], ...many), true);
});

test('gate_quiet in release/lib.sh stops a release while Terraform runs, and lets it go for a stand-in', () => {
  const gate = (line) => bash(`set -euo pipefail; . "${lib}"; gate_quiet; echo passed`, [line]);
  const stopped = gate(REAL[0]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /^STOP: a terraform process is running$/m);
  assert.doesNotMatch(stopped.stdout, /passed/);
  const passed = gate(STUBS[0]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /passed/);
});

test('the real pgrep shows a running stand-in as a shell command line, and the check ignores it', async () => {
  const stand = join(box, 'stand', 'terraform');
  mkdirSync(join(box, 'stand'));
  write(stand, 'sleep 30');
  const child = spawn(stand, ['-chdir=/tmp/clone', 'plan', '-input=false'], { stdio: 'ignore' });
  try {
    // The real pgrep, narrowed to this process by its PID: what another session's suite would show this one. Not by its path: macOS (BSD) pgrep
    // -fl prints the whole command line, but procps pgrep -fl, on Linux and so in CI, prints only the process name, here `bash`.
    const narrowed = join(box, 'narrowed');
    mkdirSync(narrowed);
    write(join(narrowed, 'pgrep'), `/usr/bin/pgrep "$@" | grep -E -- "^${child.pid} "`);
    let seen = '';
    for (let i = 0; i < 50 && !seen; i++) {
      seen = spawnSync(join(narrowed, 'pgrep'), ['-fl', 'terraform.*(apply|plan|import|untaint)'], { encoding: 'utf8' }).stdout.trim();
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(seen, new RegExp(`^${child.pid} (\\S*/)?bash( |$)`), 'either form is a shell line');
    if (process.platform === 'darwin') assert.match(seen, /^[0-9]+ (\S*\/)?bash \S+\/stand\/terraform -chdir=\/tmp\/clone plan -input=false$/);
    const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${check}"; if terraform_running; then echo running; else echo quiet; fi`], {
      encoding: 'utf8',
      env: { PATH: `${narrowed}:${process.env.PATH}`, HOME: box, TMPDIR: box },
    });
    assert.equal(r.stdout.trim(), 'quiet', r.stderr);
  } finally {
    child.kill();
  }
});
