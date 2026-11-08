import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A check that passes whatever happens is worse than no check, because it reads as coverage. Four ways that has happened here, one rule each:
// a job that cannot fail, a test that skips where it runs, a test script nothing runs, and a test that pins a file that does not exist.
// An exception is written down below with its reason. An entry that no longer matches anything fails too, so the lists cannot go stale.

const self = basename(fileURLToPath(import.meta.url));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** { workflow, job, why }: jobs allowed to set continue-on-error. Empty on purpose: a job that cannot fail must say why here. */
const CONTINUE_ON_ERROR = [];

/** { pkg, script, why }: test scripts that no workflow runs, on purpose. */
const LOCAL_ONLY_SCRIPTS = [
  { pkg: '@telesphoros/ai-service', script: 'test:durable:pg', why: 'Declared local-only by vitest.durable.config.mts: it needs a loopback PostgreSQL its runner owns. Whether ai-service stays at all is open (simplify audit 2026-11-07, finding 16).' },
  { pkg: 'telesphoros-remastered', script: 'test:storage-rehearsal', why: 'Explicit local acceptance (its own header says so); it needs local services that CI does not start.' },
  { pkg: 'telesphoros-remastered', script: 'test:storage-recovery', why: 'Local regression for the foreground supervisor; it needs explicit local runtimes and has no service discovery.' },
  { pkg: 'telesphoros-remastered', script: 'test:product-demo', why: 'Runs only against an already-started, owned synthetic demo at a fixed loopback URL; CI has no such demo.' },
  { pkg: '@telesphoros/backend', script: 'test:db', why: 'Local shorthand for the command service-postgres runs as Tier 2, spelled there through pnpm --filter.' },
  { pkg: '@telesphoros/smart-pilot', script: 'test:browser', why: 'Optional check through a locally installed browser driver against dedicated synthetic localhost pages.' },
  { pkg: '@telesphoros/smart-pilot', script: 'test:ehr-guard', why: 'Exercises the seed predicate on the local MariaDB of an OpenEMR install; CI has no EHR.' },
  { pkg: '@telesphoros/smart-pilot', script: 'test:workflow', why: 'Opt-in workflow against a real local EHR; it fails rather than skips when the services are missing.' },
];

/** { literal, why }: paths that CI tests name without meaning a file in this repository. */
const INVENTED_PATHS = [
  { literal: '.github/workflows/other.yml', why: 'staging-release.test.mjs: a CI run from another workflow, which publishing must refuse.' },
  { literal: 'docs/.gitkeep', why: 'scope.test.mjs: a non-markdown file under docs/ that must not count as documentation.' },
  { literal: 'docs/config/model-id.md', why: 'scope.test.mjs: the invented markdown home of a model ID, the case that must be skipped.' },
  { literal: 'docs/design/previews/notes.md', why: 'scope.test.mjs: an invented markdown file deep under docs/ that counts as documentation.' },
  { literal: 'docs/no-such-page.md', why: 'guard.test.mjs: the broken link the documentation-link control plants on purpose.' },
  { literal: 'docs/old.md', why: 'scope.test.mjs: a file the changed-files test creates in a temporary repository and removes.' },
  { literal: 'docs/ops/new-note.md', why: 'scope.test.mjs: a file the changed-files test creates in a temporary repository.' },
  { literal: 'infrastructure/lambda/x/index.js', why: 'scope.test.mjs: invented Lambda source that must count as infrastructure.' },
  { literal: 'infrastructure/terraform/api.tf', why: 'scope.test.mjs: an invented Terraform file that must count as infrastructure.' },
  { literal: 'knowledge/lab-report-reader/v2-handoff/ORIGIN.md', why: 'scope.test.mjs: markdown outside docs/ that must not count as documentation.' },
  { literal: 'scripts/staging/run-task.mjs', why: 'scope.test.mjs: an invented script that must not count as infrastructure.' },
  { literal: 'tests/policy.tftest.hcl', why: 'guard.test.mjs: relative to infrastructure/terraform-state, where the file exists.' },
];

const DATABASE_ENV = 'TEST_DATABASE_URL';
const SKIP = /\b(?:describe|test|it)\.skip\b|\bskipIf\b|\bskip:|NOT RUNNING|\bskipped\.push\b/;
const uncommented = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The manifest of a package matched by a pnpm-workspace glob, where each `*` stands for one directory name. */
const manifestOf = glob => new RegExp(`^${glob.split('*').map(escapeRegExp).join('[^/]+')}/package\\.json$`);

/** The jobs of one workflow, comments removed so that a comment can neither run a script nor set an option. */
function jobsOf(text) {
  const body = uncommented(text).split(/^jobs:\s*$/m)[1] ?? '';
  return body.split(/^ {2}(?=[A-Za-z0-9_-]+:\s*$)/m).slice(1).map(block => ({ key: block.match(/^([A-Za-z0-9_-]+):/)[1], text: block }));
}

const unlisted = (entries, used, label, describe) => entries.filter(entry => !used.has(entry)).map(entry => `${label} entry ${describe(entry)} no longer matches anything: remove it`);
const unexplained = (entries, label, describe) => entries.filter(entry => !(entry.why?.trim().length >= 20)).map(entry => `${label} entry ${describe(entry)} needs a reason`);

// ---- 1. a job or step that cannot fail ----

function continueOnErrorProblems(tree, allowed = CONTINUE_ON_ERROR) {
  const label = entry => `${entry.workflow}/${entry.job}`;
  const problems = unexplained(allowed, 'CONTINUE_ON_ERROR', label);
  const used = new Set();
  for (const [workflow, text] of Object.entries(tree.workflows)) for (const job of jobsOf(text)) {
    if (![...job.text.matchAll(/^[ -]*["']?continue-on-error["']?\s*:\s*(.+?)\s*$/gm)].some(([, value]) => value !== 'false')) continue;
    const entry = allowed.find(e => e.workflow === workflow && e.job === job.key);
    if (entry) used.add(entry);
    else problems.push(`${workflow} job ${job.key} sets continue-on-error, so it cannot go red: remove it, or add { workflow, job, why } to CONTINUE_ON_ERROR`);
  }
  return [...problems, ...unlisted(allowed, used, 'CONTINUE_ON_ERROR', label)];
}

// ---- what each workflow job actually runs ----

function calledScripts(text, from, packages) {
  const byName = new Map(packages.map(p => [p.name, p]));
  const calls = [];
  for (const [, filters, script] of text.matchAll(/\bpnpm((?:\s+--filter[= ]\S+)+)\s+(?:run\s+)?([\w:.-]+)/g))
    for (const [, name] of filters.matchAll(/--filter[= ](\S+)/g)) calls.push([name, script]);
  for (const [, script] of text.matchAll(/\bpnpm\s+(?:run\s+)?([a-z][\w:.-]*)/g)) calls.push([from, script]);
  // scripts/workspace-build/workspace.cjs ends in `pnpm -r --if-present <command>`, which runs in every workspace package and not in the root.
  for (const [, command] of text.matchAll(/workspace\.cjs run (\w+)/g)) for (const p of packages) if (p.dir) calls.push([p.name, command]);
  return calls.filter(([name, script]) => byName.get(name)?.scripts[script] !== undefined);
}

const nodeTestFiles = (text, dir) => [...text.matchAll(/\bnode\s+--test\s+([^&|;\n]+)/g)]
  .flatMap(([, args]) => args.trim().split(/\s+/).filter(arg => !arg.startsWith('-')).map(arg => posix.normalize(posix.join(dir, arg))));

/** `pkg#script` -> the workflow jobs that run it, directly, through a script a job runs, or by running every file the script names. */
function reachOf(tree) {
  const { packages } = tree;
  const rootPackage = packages.find(p => !p.dir);
  const reached = new Map();
  const files = new Map();
  const add = (map, key, job) => { if (!map.has(key)) map.set(key, new Set()); const fresh = !map.get(key).has(job); map.get(key).add(job); return fresh; };
  const visit = (text, pkg, job) => {
    for (const file of nodeTestFiles(text, pkg.dir)) add(files, file, job);
    for (const [name, script] of calledScripts(text, pkg.name, packages)) {
      const callee = packages.find(p => p.name === name);
      if (add(reached, `${name}#${script}`, job)) visit(callee.scripts[script], callee, job);
    }
  };
  for (const [workflow, text] of Object.entries(tree.workflows)) for (const job of jobsOf(text)) visit(job.text, rootPackage, `${workflow}/${job.key}`);
  for (const pkg of packages) for (const [script, body] of Object.entries(pkg.scripts)) {
    const key = `${pkg.name}#${script}`;
    if (reached.has(key) || !/^node\s+--test\s+[^&|;]+$/.test(body.trim())) continue;
    const named = nodeTestFiles(body, pkg.dir);
    if (named.length && named.every(file => files.has(file))) for (const file of named) for (const job of files.get(file)) add(reached, key, job);
  }
  return reached;
}

const jobText = (tree, label) => { const [workflow, key] = label.split('/'); return jobsOf(tree.workflows[workflow]).find(job => job.key === key)?.text ?? ''; };
const providesDatabase = job => new RegExp(`^\\s+${DATABASE_ENV}:\\s*\\S`, 'm').test(job) && /^ {4}services:\s*$/m.test(job) && /^\s+image:\s*["']?postgres:/m.test(job);

// ---- 2. a test that skips in the only place it runs ----

/** The files behind one script that quietly drop tests when there is no database. */
function databaseSkipFiles(pkg, body, tree) {
  const named = [...nodeTestFiles(body, pkg.dir)];
  for (const [, file] of body.matchAll(/\bnode\s+(?!--)(\S+\.[cm]?js)\b/g)) named.push(posix.normalize(posix.join(pkg.dir, file)));
  if (/\b(?:jest|vitest)\b/.test(body)) named.push(...tree.files.filter(file => file.startsWith(`${pkg.dir}/`)
    && (/[.-](?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /^(?:jest|vitest)[\w.]*\.config\.[cm]?[jt]s$/.test(basename(file)))));
  return [...new Set(named)].filter(file => { const text = tree.read(file); return text !== null && text.includes(DATABASE_ENV) && SKIP.test(text); });
}

function databaseSkipProblems(tree) {
  const reached = reachOf(tree);
  const problems = [];
  for (const pkg of tree.packages) for (const [script, body] of Object.entries(pkg.scripts)) {
    if (!script.startsWith('test')) continue;
    const jobs = [...(reached.get(`${pkg.name}#${script}`) ?? [])];
    const skipping = databaseSkipFiles(pkg, body, tree);
    // A script no job runs is the next rule's business; here it would only be reported twice.
    if (skipping.length && jobs.length && !jobs.some(job => providesDatabase(jobText(tree, job))))
      problems.push(`${pkg.name} ${script} skips without a database (${skipping.join(', ')}) and runs only in ${jobs.join(', ')}, which provide none: run it in a job with a PostgreSQL service and ${DATABASE_ENV}`);
  }
  return problems;
}

// ---- 3. a test script nothing runs ----

function unreachedProblems(tree, allowed = LOCAL_ONLY_SCRIPTS) {
  const label = entry => `${entry.pkg} ${entry.script}`;
  const reached = reachOf(tree);
  const problems = unexplained(allowed, 'LOCAL_ONLY_SCRIPTS', label);
  const used = new Set();
  for (const pkg of tree.packages) for (const script of Object.keys(pkg.scripts)) {
    if (!script.startsWith('test')) continue;
    const entry = allowed.find(e => e.pkg === pkg.name && e.script === script);
    if (reached.has(`${pkg.name}#${script}`)) {
      if (entry) problems.push(`${label(entry)} is listed as local-only but CI runs it: remove the entry`), used.add(entry);
    } else if (entry) used.add(entry);
    else problems.push(`${pkg.name} ${script} is run by no workflow: run it in CI, or add { pkg, script, why } to LOCAL_ONLY_SCRIPTS`);
  }
  return [...problems, ...unlisted(allowed, used, 'LOCAL_ONLY_SCRIPTS', label)];
}

// ---- 4. a test that pins a file that does not exist ----

/** Every string literal in a CI test that is shaped like a path inside this repository, as [file, line, path]. */
function pinnedPaths(tree) {
  const tops = [...new Set(tree.files.filter(file => file.includes('/')).map(file => file.split('/')[0]))];
  const literal = new RegExp(`(['"\`])((?:${tops.map(escapeRegExp).join('|')})/[\\w@.\\-/]*[\\w@.\\-])\\1`, 'g');
  const found = [];
  for (const [file, text] of Object.entries(tree.ciTests)) text.split('\n').forEach((line, index) => { for (const match of line.matchAll(literal)) found.push([file, index + 1, match[2]]); });
  return found;
}

function phantomPathProblems(tree, allowed = INVENTED_PATHS) {
  const problems = unexplained(allowed, 'INVENTED_PATHS', entry => entry.literal);
  const used = new Set();
  // A single-letter file name (a.ts, x.md) is how these tests spell an input they made up.
  const candidates = pinnedPaths(tree).filter(([, , path]) => !/^[A-Za-z]\./.test(posix.basename(path)) && !tree.exists(path));
  const ignored = tree.ignored([...new Set(candidates.map(([, , path]) => path))]);
  for (const [file, line, path] of candidates) {
    if (ignored.has(path)) continue;
    const entry = allowed.find(e => e.literal === path);
    if (entry) used.add(entry);
    else problems.push(`${file}:${line} pins ${path}, which does not exist: fix the path, or add { literal, why } to INVENTED_PATHS`);
  }
  return [...problems, ...unlisted(allowed, used, 'INVENTED_PATHS', entry => entry.literal)];
}

// ---- the repository as the rules see it ----

function realTree() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  const read = file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return null; } };
  const lines = read('pnpm-workspace.yaml').split('\n');
  const patterns = lines.slice(lines.indexOf('packages:') + 1).map(line => line.match(/^ {2}- "(.+)"$/)?.[1]);
  const globs = patterns.slice(0, patterns.indexOf(undefined)).map(manifestOf);
  const manifests = ['package.json', ...files.filter(file => globs.some(glob => glob.test(file)))];
  const packages = manifests.map(file => { const manifest = JSON.parse(read(file)); return { dir: file === 'package.json' ? '' : dirname(file), name: manifest.name, scripts: manifest.scripts ?? {} }; });
  const workflowDir = join(root, '.github/workflows');
  const workflows = Object.fromEntries(readdirSync(workflowDir).filter(file => /\.ya?ml$/.test(file)).map(file => [file, readFileSync(join(workflowDir, file), 'utf8')]));
  const ciDir = join(root, '.github/ci');
  const ciTests = Object.fromEntries(readdirSync(ciDir).filter(file => file.endsWith('.test.mjs') && file !== self).map(file => [file, readFileSync(join(ciDir, file), 'utf8')]));
  const ignored = paths => {
    // A directory pattern such as `test-results/` matches a path that does not exist only when it is asked about with the trailing slash.
    const asked = paths.flatMap(path => [path, `${path}/`]);
    const run = spawnSync('git', ['check-ignore', '--stdin'], { cwd: root, input: asked.join('\n'), encoding: 'utf8' });
    if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed with status ${run.status}`);
    const hits = new Set(run.stdout.split('\n').filter(Boolean));
    return new Set(paths.filter(path => hits.has(path) || hits.has(`${path}/`)));
  };
  return { files, packages, workflows, ciTests, read, ignored, exists: path => existsSync(join(root, path)) };
}

const real = realTree();

test('the guard sees the repository (a parser that finds nothing would pass every rule)', () => {
  assert.ok(Object.keys(real.workflows).length >= 4, 'workflows');
  assert.ok(jobsOf(real.workflows['ci.yml']).length >= 10, 'jobs in ci.yml');
  assert.ok(real.packages.length >= 12, 'workspace packages');
  assert.ok(reachOf(real).size >= 15, 'scripts reached by a workflow');
  assert.ok(pinnedPaths(real).length >= 100, 'paths pinned by CI tests');
  const reachedBy = script => [...(reachOf(real).get(script) ?? [])];
  assert.ok(reachedBy('@telesphoros/backend#test').includes('ci.yml/service-postgres'), 'a filtered call is followed');
  assert.ok(reachedBy('@telesphoros/jobs#test').includes('ci.yml/verify'), 'the workspace runner reaches every package');
});

test('rule 1: no job or step sets continue-on-error without a written reason', () => assert.deepEqual(continueOnErrorProblems(real), []));
test('rule 2: every test script that skips without a database runs in a job that provides one', () => assert.deepEqual(databaseSkipProblems(real), []));
test('rule 3: every test script is run by a workflow or written down as local-only', () => assert.deepEqual(unreachedProblems(real), []));
test('rule 4: every path a CI test pins exists, or is written down as invented', () => assert.deepEqual(phantomPathProblems(real), []));

// ---- each rule can go red ----

const ROOT = 'root-package';
const workflow = (job, body = '      - run: pnpm test\n') => `name: x\non: push\njobs:\n  ${job}:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const POSTGRES_JOB = `jobs:\n  db:\n    runs-on: ubuntu-24.04\n    services:\n      postgres:\n        image: postgres:16@sha256:abc\n    env:\n      ${DATABASE_ENV}: postgres://x\n    steps:\n      - run: pnpm test:seed\n`;
function sampleTree({ workflows = { 'ci.yml': workflow('verify') }, scripts = { test: 'node --test a.test.cjs' }, contents = {}, files = [], ciTests = {}, existing = [], gitignored = [] } = {}) {
  return { workflows, ciTests, packages: [{ dir: '', name: ROOT, scripts }], files: ['apps/x/y.ts', ...Object.keys(contents), ...files],
    read: file => contents[file] ?? null, exists: path => existing.includes(path), ignored: paths => new Set(paths.filter(path => gitignored.includes(path))) };
}
const allow = (extra = {}) => ({ why: 'A reason long enough to mean something.', ...extra });

test('control: a workspace glob reads every star as one directory and every other character literally', () => {
  assert.ok(manifestOf('infrastructure/lambda/*').test('infrastructure/lambda/x/package.json'));
  assert.ok(manifestOf('a/*/b/*').test('a/x/b/y/package.json'), 'every star counts, not only the first');
  assert.ok(!manifestOf('a/*').test('a/x/y/package.json'), 'a star stops at a slash');
  assert.ok(!manifestOf('a.b/*').test('axb/c/package.json'), 'a dot is a dot');
});

test('control, rule 1: a job or a step that cannot fail is refused, whatever the spelling; false and a written reason are not', () => {
  for (const value of ['true', '"true"', '${{ matrix.experimental }}']) {
    assert.equal(continueOnErrorProblems(sampleTree({ workflows: { 'ci.yml': workflow('lint').replace('    steps:', `    continue-on-error: ${value}\n    steps:`) } }), []).length, 1, value);
    assert.equal(continueOnErrorProblems(sampleTree({ workflows: { 'ci.yml': workflow('lint', `      - run: x\n        continue-on-error: ${value}\n`) } }), []).length, 1, value);
  }
  const off = sampleTree({ workflows: { 'ci.yml': workflow('lint').replace('    steps:', '    continue-on-error: false\n    steps:') } });
  assert.deepEqual(continueOnErrorProblems(off, []), []);
  const commented = sampleTree({ workflows: { 'ci.yml': workflow('lint').replace('    steps:', '    # continue-on-error: true\n    steps:') } });
  assert.deepEqual(continueOnErrorProblems(commented, []), []);
  const on = sampleTree({ workflows: { 'ci.yml': workflow('lint').replace('    steps:', '    continue-on-error: true\n    steps:') } });
  assert.deepEqual(continueOnErrorProblems(on, [allow({ workflow: 'ci.yml', job: 'lint' })]), []);
  assert.match(continueOnErrorProblems(on, [{ workflow: 'ci.yml', job: 'lint', why: '' }]).join(), /needs a reason/);
  assert.match(continueOnErrorProblems(sampleTree(), [allow({ workflow: 'ci.yml', job: 'gone' })]).join(), /no longer matches/);
});

test('control, rule 2: a test that skips without a database must reach a job that has one', () => {
  const contents = { 'seed.test.cjs': `const url = process.env.${DATABASE_ENV};\ntest('x', { skip: url ? false : 'no database' }, () => {});\n` };
  const scripts = { 'test:seed': 'node --test seed.test.cjs' };
  const noDatabase = workflow('verify', '      - run: pnpm test:seed\n');
  assert.match(databaseSkipProblems(sampleTree({ workflows: { 'ci.yml': noDatabase }, scripts, contents })).join(), /test:seed skips without a database \(seed\.test\.cjs\) and runs only in ci\.yml\/verify/);
  assert.deepEqual(databaseSkipProblems(sampleTree({ workflows: { 'ci.yml': POSTGRES_JOB }, scripts, contents })), []);
  // The variable alone is not a database, and neither is a service without the variable.
  assert.equal(databaseSkipProblems(sampleTree({ workflows: { 'ci.yml': POSTGRES_JOB.replace(/ {4}services:\n.*\n.*\n/, '') }, scripts, contents })).length, 1);
  assert.equal(databaseSkipProblems(sampleTree({ workflows: { 'ci.yml': POSTGRES_JOB.replace(`      ${DATABASE_ENV}: postgres://x\n`, '      OTHER: x\n') }, scripts, contents })).length, 1);
  // A file that fails without the database, rather than skipping, is fine anywhere.
  const failing = { 'seed.test.cjs': `if (!process.env.${DATABASE_ENV}) throw new Error('required');\n` };
  assert.deepEqual(databaseSkipProblems(sampleTree({ workflows: { 'ci.yml': noDatabase }, scripts, contents: failing })), []);
  // A runner's own configuration and its test files count, not only the files a script names.
  const pkg = { dir: 'apps/w', name: 'w', scripts: {} };
  const tree = { files: ['apps/w/vitest.config.mts', 'apps/w/test/a.pg-spec.ts', 'apps/w/test/b.test.ts'], read: file => ({ 'apps/w/vitest.config.mts': `process.env.${DATABASE_ENV}; 'NOT RUNNING'`, 'apps/w/test/a.pg-spec.ts': `(process.env.${DATABASE_ENV} ? describe : describe.skip)('x')`, 'apps/w/test/b.test.ts': 'plain' })[file] };
  assert.deepEqual(databaseSkipFiles(pkg, 'vitest run', tree), ['apps/w/vitest.config.mts', 'apps/w/test/a.pg-spec.ts']);
});

test('control, rule 3: a test script nothing runs is reported; each honest way of being reached is not', () => {
  const unreached = { test: 'node --test a.test.cjs', 'test:orphan': 'node x.cjs' };
  assert.match(unreachedProblems(sampleTree({ scripts: unreached }), []).join(), /test:orphan is run by no workflow/);
  assert.deepEqual(unreachedProblems(sampleTree({ scripts: unreached }), [allow({ pkg: ROOT, script: 'test:orphan' })]), []);
  assert.match(unreachedProblems(sampleTree({ scripts: unreached }), [{ pkg: ROOT, script: 'test:orphan', why: 'no' }]).join(), /needs a reason/);
  assert.match(unreachedProblems(sampleTree(), [allow({ pkg: ROOT, script: 'test' })]).join(), /listed as local-only but CI runs it/);
  assert.match(unreachedProblems(sampleTree(), [allow({ pkg: ROOT, script: 'test:gone' })]).join(), /no longer matches/);
  // A comment naming the script runs nothing, and a script only another unrun script calls is still unrun.
  const commented = workflow('verify', '      # pnpm test:orphan\n      - run: pnpm test\n');
  assert.match(unreachedProblems(sampleTree({ workflows: { 'ci.yml': commented }, scripts: unreached }), []).join(), /test:orphan/);
  const chained = { test: 'node --test a.test.cjs', 'test:a': 'pnpm test:b', 'test:b': 'node x.cjs' };
  assert.equal(unreachedProblems(sampleTree({ scripts: chained }), []).length, 2);
  // Called through a reached script, or every file it names run elsewhere.
  assert.deepEqual(unreachedProblems(sampleTree({ scripts: { test: 'node x.cjs && pnpm test:b', 'test:b': 'node y.cjs' } }), []), []);
  assert.deepEqual(unreachedProblems(sampleTree({ scripts: { test: 'node --test a.test.cjs b.test.cjs', 'test:a': 'node --test b.test.cjs' } }), []), []);
  assert.equal(unreachedProblems(sampleTree({ scripts: { test: 'node --test a.test.cjs', 'test:a': 'node --test a.test.cjs c.test.cjs' } }), []).length, 1);
});

test('control, rule 4: a pinned path that does not exist is reported with its line; real, ignored, placeholder and listed ones are not', () => {
  const ciTests = { 'a.test.mjs': "const x = 1;\nfor (const p of ['apps/x/gone.ts', 'apps/x/y.ts', 'apps/x/zed.ts', 'apps/a.ts', 'apps/x/out/report.json', 'nothing/gone.ts']) check(p);\n" };
  const tree = sampleTree({ ciTests, existing: ['apps/x/y.ts'], gitignored: ['apps/x/out/report.json'] });
  const invented = [allow({ literal: 'apps/x/zed.ts' })];
  assert.deepEqual(phantomPathProblems(tree, invented), ['a.test.mjs:2 pins apps/x/gone.ts, which does not exist: fix the path, or add { literal, why } to INVENTED_PATHS']);
  assert.match(phantomPathProblems(tree, []).join(), /pins apps\/x\/zed\.ts/);
  assert.match(phantomPathProblems(tree, [{ literal: 'apps/x/zed.ts', why: '' }]).join(), /needs a reason/);
  assert.match(phantomPathProblems(sampleTree(), [allow({ literal: 'apps/x/never.ts' })]).join(), /no longer matches/);
});
