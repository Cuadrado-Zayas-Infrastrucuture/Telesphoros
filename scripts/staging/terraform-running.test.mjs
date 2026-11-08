// Tests for scripts/staging/terraform-running.sh, the check behind release/lib.sh gate_quiet and staging-status.sh's plan row. Imported by
// infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it. Stand-in `pgrep -x NAME` and `ps -o args= -p PID` answer from a
// process table each test names, so no test here depends on what else runs on the machine. The last test runs real processes under a name
// nothing else has (tfp<pid>); it is skipped where pgrep cannot read the process list (a sandboxed agent session), and runs in CI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const check = join(root, 'scripts/staging/terraform-running.sh');
const lib = join(root, 'scripts/staging/release/lib.sh');
const box = mkdtempSync(join(tmpdir(), 'terraform-running-'));
const children = [];
after(() => { for (const c of children) c.kill('SIGKILL'); rmSync(box, { recursive: true, force: true }); });
const bin = join(box, 'bin');
mkdirSync(bin);
const write = (path, body) => { writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`); chmodSync(path, 0o755); };
// pgrep exits 1 and prints nothing when no process matches; otherwise it prints `PID command line`, one per process. The lines come from a
// file, since a test below lists more than an environment variable can hold. PGREP_EXIT makes it fail the way a real pgrep does when it
// cannot read the process list (exit 3 in the macOS sandbox) or is missing (127).
const listed = join(box, 'pgrep-lines');
const asked = join(box, 'pgrep-args');
write(
  join(bin, 'pgrep'),
  `printf '%s\\n' "$@" > "${asked}"\n[ -z "\${PGREP_EXIT:-}" ] || { echo 'pgrep: Cannot get process list' >&2; exit "$PGREP_EXIT"; }\n[ -s "${listed}" ] || exit 1\ncat "${listed}"`,
);
// The table: one `PID NAME COMMAND LINE` per line, NAME being what `pgrep -x` matches (the executable's name). pgrep exits 1 when no process
// has the name, and STUB_PGREP_EXIT when set (3: macOS pgrep in a sandbox, "Cannot get process list"). Every pgrep call is logged.
const table = join(box, 'procs');
const asked = join(box, 'pgrep-args');
write(join(bin, 'pgrep'), [
  `printf '%s\\n' "$*" >> "${asked}"`,
  '[ -z "${STUB_PGREP_EXIT:-}" ] || exit "$STUB_PGREP_EXIT"',
  `found=1; while read -r pid name _; do [ "$name" = "\${!#}" ] && { echo "$pid"; found=0; }; done < "${table}"; exit $found`,
].join('\n'));
write(join(bin, 'ps'), `while read -r pid _ args; do [ "$pid" = "\${!#}" ] && { echo "$args"; exit 0; }; done < "${table}"; exit 1`);

const bash = (code, procs, env = {}) => {
  writeFileSync(table, procs.map((p, i) => `${4242 + i} ${p}`).join('\n') + (procs.length ? '\n' : ''));
  writeFileSync(asked, '');
  return spawnSync('bash', ['-c', code], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: box, TMPDIR: box, ...env } });
};
const status = (procs, env) => {
  const r = bash(`set -euo pipefail; . "${check}"; st=0; terraform_running || st=$?; echo "$st"`, procs, env);
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
};
const running = (...procs) => status(procs) === 0;

// NAME then the command line, as ps prints it.
const REAL = [
  'terraform /opt/homebrew/bin/terraform -chdir=/x/infrastructure/terraform plan -input=false -out=a.tfplan',
  'terraform terraform apply a.tfplan',
  'terraform /Users/someone/.tfenv/versions/1.16.5/terraform import aws_s3_bucket.b name',
  'terraform /usr/local/bin/terraform untaint aws_instance.a',
  'docker docker run --rm hashicorp/terraform:1.16.5 plan',
];
// The suites' stand-in terraform is a bash script. On Linux its process is named after the script, so pgrep -x terraform finds it.
const STUBS = [
  'terraform bash /tmp/staging-status-sh-x/bin/terraform -chdir=/tmp/clone/infrastructure/terraform plan -input=false',
  'terraform /bin/bash /tmp/release-after-y/bin/terraform apply -input=false a.tfplan',
  'terraform /opt/homebrew/bin/bash /tmp/z/bin/terraform import a b',
  'terraform /usr/bin/env bash /tmp/z/bin/terraform plan',
  'terraform -bash /tmp/z/bin/terraform plan',
  'terraform dash /tmp/z/bin/terraform untaint a',
];
// What once stopped the status plan: processes that are not Terraform, whose command line mentions a terraform plan or apply.
const MENTIONS = [
  'zsh zsh -c sleep 600; : terraform -chdir=/x plan -input=false',
  'bash /bin/bash -c terraform apply',
  'node node /x/codex.js exec "run terraform -chdir=/x plan and report"',
  'rg rg terraform.*plan docs/ops',
  'tail tail -f /x/infrastructure/terraform/plan.log apply',
  'perl perl -e sleep terraform -chdir=/x plan',
  'docker docker run --rm alpine sh -c plan',
];

test('it asks pgrep for processes by exact name: terraform, the file name of TERRAFORM, and docker', () => {
  bash(`. "${check}"; TERRAFORM=/opt/tools/terraform-1.16.5; terraform_running || true`, []);
  assert.deepEqual(readFileSync(asked, 'utf8').split('\n').filter(Boolean), ['-x -- terraform', '-x -- terraform-1.16.5', '-x -- docker']);
});

test('a real Terraform plan, apply, import or untaint is running: from its own path, a bare name, a tfenv version, or docker', () => {
  for (const p of REAL) assert.equal(running(p), true, p);
});

test('a shell running a stand-in terraform is not Terraform running, even where its process carries the name', () => {
  for (const p of STUBS) assert.equal(running(p), false, p);
});

test('a process that only mentions terraform in its command line is not Terraform running, shell or not', () => {
  for (const p of MENTIONS) assert.equal(running(p), false, p);
});

test('a Terraform running a read-only command is not running a plan; the subcommand must be a whole argument', () => {
  for (const p of ['terraform terraform -chdir=/x state pull', 'terraform terraform version', 'terraform terraform -chdir=/plan/x show -json a.tfplan', 'terraform terraform output planned']) {
    assert.equal(running(p), false, p);
  }
});

test('one real run among stand-ins and mentions still counts, in any order, and nothing listed is quiet', () => {
  assert.equal(running(STUBS[0], REAL[0], MENTIONS[0]), true);
  assert.equal(running(...MENTIONS, ...STUBS, REAL[4]), true);
  assert.equal(running(REAL[1], ...STUBS), true);
  assert.equal(running(), false);
});

test('only a shell is ignored, not a command whose name ends in "sh"', () => {
  for (const p of ['terraform /usr/local/bin/push plan', 'terraform /opt/x/flash apply', 'terraform bashful plan', 'terraform /opt/x/ssh plan']) {
    assert.equal(running(p), true, p);
  }
});

test('a process list that cannot be read answers 2, never quiet', () => {
  assert.equal(status([], { STUB_PGREP_EXIT: '3' }), 2);
  assert.equal(status([REAL[0]], { STUB_PGREP_EXIT: '2' }), 2);
});

test('gate_quiet in release/lib.sh stops a release while Terraform runs or the process list cannot be read, and lets it go otherwise', () => {
  const gate = (procs, env) => bash(`set -euo pipefail; . "${lib}"; TERRAFORM=/opt/tools/terraform; gate_quiet; echo passed`, procs, env);
  const stopped = gate([REAL[0]]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /^STOP: a terraform process is running$/m);
  assert.doesNotMatch(stopped.stdout, /passed/);
  const refused = gate([], { STUB_PGREP_EXIT: '3' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^STOP: the process list could not be read, so a running terraform cannot be ruled out$/m);
  const passed = gate([STUBS[0], MENTIONS[0], MENTIONS[2]]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /passed/);
});

test('a pgrep that cannot read the process list, or is missing, counts as running: gate_quiet stops and says why', () => {
  for (const code of ['2', '3', '127']) {
    const r = bash(`set -euo pipefail; . "${check}"; if terraform_running; then echo running; else echo quiet; fi`, [], { PGREP_EXIT: code });
    assert.equal(r.stdout.trim(), 'running', `pgrep exit ${code}`);
    assert.match(r.stderr, new RegExp(`cannot read the process list \\(pgrep exit ${code}\\)`));
    const gate = bash(`set -euo pipefail; . "${lib}"; gate_quiet; echo passed`, [], { PGREP_EXIT: code });
    assert.equal(gate.status, 1, `pgrep exit ${code}`);
    assert.doesNotMatch(gate.stdout, /passed/);
  }
});

test('the real pgrep shows a running stand-in as a shell command line, and the check ignores it', async () => {
  const stand = join(box, 'stand', 'terraform');
const NAME = `tfp${process.pid}`; // under 15 characters: Linux truncates a process name there
const unreadable = spawnSync('pgrep', ['-x', `${NAME}none`], { encoding: 'utf8' }).status >= 2;

test('real processes: a shell that mentions the name, a stand-in script of that name and a read-only command are quiet; that binary running plan is not', {
  skip: unreadable && 'pgrep cannot read the process list here (a sandbox)',
}, async () => {
  const real = (env = {}) => spawnSync('bash', ['-c', '. "$1"; st=0; terraform_running "$2" || st=$?; echo "$st"', '_', check, NAME], {
    encoding: 'utf8', env: { ...process.env, ...env },
  }).stdout.trim();
  const start = async (cmd, args) => { const c = spawn(cmd, args, { stdio: 'ignore' }); children.push(c); await once(c, 'spawn'); return c; };
  const stop = async (c) => { c.kill('SIGKILL'); await once(c, 'exit'); };
  const dir = join(box, 'real');
  mkdirSync(dir);
  const binary = join(dir, NAME);
  symlinkSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(), binary); // the process is named after the link
  const script = join(box, 'stand', NAME);
  mkdirSync(join(box, 'stand'));
  write(script, 'sleep 60'); // on Linux this process is named NAME too
  assert.equal(real(), '1', 'nothing so named is running');

  const shell = await start('bash', ['-c', `sleep 60; : ${NAME} -chdir=/x plan -input=false`]);
  const old = spawnSync('pgrep', ['-f', `${NAME}.*(apply|plan|import|untaint)`], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(old.includes(String(shell.pid)), 'control: a whole-command-line match takes the shell for Terraform');
  const other = await start(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', NAME, '-chdir=/x', 'plan']);
  const stand = await start(script, ['-chdir=/x', 'plan', '-input=false']);
  const readOnly = await start(binary, ['-c', 'sleep 60; :', NAME, '-chdir=/x', 'state', 'pull']);
  assert.equal(real(), '1', 'a shell and a node process that mention it, a stand-in script, a read-only command');

  const plan = await start(binary, ['-c', 'sleep 60; :', NAME, '-chdir=/x', 'plan', '-input=false']);
  assert.equal(real(), '0', 'positive control: a binary so named, running plan');
  await stop(plan);
  const apply = await start(binary, ['-c', 'sleep 60; :', NAME, 'apply', 'a.tfplan']);
  assert.equal(real(), '0', 'and running apply');
  for (const c of [apply, readOnly, stand, other, shell]) await stop(c);
  assert.equal(real(), '1', 'all ended');
});
