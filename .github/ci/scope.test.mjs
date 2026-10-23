// Run with: node --test .github/ci/scope.test.mjs   (part of pnpm test:ci-config)
// Controls for the run-scope decision (.github/ci/scope.mjs) and for how ci.yml uses it. A skip is only safe if the proof behind it is
// real, so every refusal below is checked on a real git repository, and every structural rule has a mutation that must turn it red.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { allRequiredPassed, changedFiles, classify, decide, docsPath, githubApi, main, requiredChecks } from './scope.mjs';
import { archiveCondition, gateCondition, guardsCondition, heavyCondition, heavyStepCondition, jobOf, terraformCondition } from './service-layout.mjs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const workflow = read('../workflows/ci.yml');
const ruleset = JSON.parse(read('../rulesets/main.json'));
const repository = 'owner/repo';

// ---- a real repository: main, a feature branch, and the merge commits GitHub would record ----

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scope-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (file, text, message) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); git(['add', file]); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']).trim(); };
  git(['init', '-q', '-b', 'main']);
  return { dir, git, commit };
}

/** main: c0, c1 (adds m). feature cut from c0, adds f. Returns the commits and a way to merge them in the shapes GitHub produces. */
function history(t) {
  const r = repo(t);
  const c0 = r.commit('a', 'a', 'c0');
  r.git(['checkout', '-q', '-b', 'feature']);
  r.commit('f', 'f', 'f1');
  r.git(['checkout', '-q', 'main']);
  const c1 = r.commit('m', 'm', 'c1');
  return { ...r, c0, c1 };
}

const green = sha => ({ workflow_runs: [{ id: 700, head_sha: sha, event: 'pull_request', status: 'completed', conclusion: 'success',
  head_repository: { full_name: repository }, repository: { full_name: repository } }] });
const jobsOf = (overrides = {}) => ({ jobs: [...requiredChecks, 'service-memory', 'changes'].map(name => ({ name, status: 'completed', conclusion: overrides[name] ?? 'success' })) });
function apiFor({ runs, jobs = jobsOf(), seen = [] } = {}) {
  return async path => {
    seen.push(path);
    if (path.includes('/actions/workflows/ci.yml/runs')) return runs;
    if (/\/actions\/runs\/\d+\/jobs/.test(path)) return jobs;
    throw new Error('unexpected path ' + path);
  };
}
const pushEnv = sha => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_REPOSITORY: repository, RELEASE_ENABLED: 'false' });

/** main with a pull request merged the way GitHub does it: the head contains main's tip, and the merge commit keeps the head's tree. */
function mergedUpToDate(t) {
  const h = history(t);
  h.git(['checkout', '-q', 'feature']);
  h.git(['merge', '-q', '--no-edit', 'main']);
  const head = h.git(['rev-parse', 'HEAD']).trim();
  h.git(['checkout', '-q', 'main']);
  h.git(['merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'feature']);
  return { ...h, head, merge: h.git(['rev-parse', 'HEAD']).trim() };
}

test('reuse: an up-to-date pull request merged with a merge commit, whose run passed every required check, skips the push run', async t => {
  const h = mergedUpToDate(t);
  assert.equal(h.git(['rev-parse', `${h.merge}^{tree}`]), h.git(['rev-parse', `${h.head}^{tree}`]), 'the fixture must model the up-to-date case');
  const seen = [];
  const result = await decide(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: green(h.head), seen }) });
  assert.equal(result.heavy, false, result.reason);
  assert.deepEqual([result.guards, result.terraform, result.archive], [false, false, false]);
  assert.match(result.reason, /verified by pull-request run 700/);
  assert.ok(seen[0].includes(`head_sha=${h.head}`) && seen[0].includes('event=pull_request'), 'it must ask for the pull-request head, not the merge commit');
  assert.equal((await decide({ ...pushEnv(h.merge), RELEASE_ENABLED: 'true' }, { git: h.git, api: apiFor({ runs: green(h.head) }) })).archive, true, 'an armed release keeps the image job');
});

test('reuse is refused: every missing proof runs everything (controls)', async t => {
  const h = mergedUpToDate(t);
  const run = { git: h.git, api: apiFor({ runs: green(h.head) }) };
  const refused = async (env, deps, pattern) => { const r = await decide(env, deps); for (const key of ['heavy', 'guards', 'terraform', 'archive']) assert.equal(r[key], true, key + ' must run: everything'); assert.match(r.reason, pattern); };
  await refused({ ...pushEnv(h.merge), GITHUB_EVENT_NAME: 'pull_request' }, run, /not a push to main/);
  await refused({ ...pushEnv(h.merge), GITHUB_EVENT_NAME: 'merge_group' }, run, /not a push to main/);
  await refused({ ...pushEnv(h.merge), GITHUB_REF: 'refs/heads/feature' }, run, /not a push to main/);
  await refused({ ...pushEnv(h.merge), GITHUB_SHA: 'not-a-sha' }, run, /unreadable|not-a-sha/);
  await refused({ ...pushEnv(h.merge), GITHUB_REPOSITORY: 'no slash' }, run, /unreadable/);
  await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: { workflow_runs: [] } }) }, /no successful pull-request run/);
  await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: green('0'.repeat(40)) }) }, /no successful pull-request run/);
  for (const [label, change] of [['failed run', { conclusion: 'failure' }], ['cancelled run', { conclusion: 'cancelled' }], ['unfinished run', { status: 'in_progress', conclusion: null }],
    ['push event', { event: 'push' }], ['fork head', { head_repository: { full_name: 'attacker/repo' } }], ['other repository', { repository: { full_name: 'attacker/repo' } }]]) {
    const runs = green(h.head); Object.assign(runs.workflow_runs[0], change);
    await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs }) }, /no successful pull-request run/);
  }
  for (const name of requiredChecks) for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: green(h.head), jobs: jobsOf({ [name]: conclusion }) }) }, /no successful pull-request run/);
  }
  await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: green(h.head), jobs: { jobs: jobsOf().jobs.filter(j => j.name !== 'browser') } }) }, /no successful pull-request run/);
  await refused(pushEnv(h.merge), { git: h.git, api: apiFor({ runs: green(h.head), jobs: { jobs: 'nope' } }) }, /no successful pull-request run/);
  await refused(pushEnv(h.merge), { git: h.git, api: async () => { throw new Error('API answered 403'); } }, /could not prove a smaller scope \(API answered 403\)/);
  await refused(pushEnv(h.merge), { git: () => { throw new Error('no git'); }, api: apiFor({ runs: green(h.head) }) }, /could not prove a smaller scope/);
});

test('reuse is refused when the merge commit is not exactly the verified head (controls on real history)', async t => {
  // A pull request that was NOT brought up to date: the merge commit contains main's later change, so its tree was never tested.
  const stale = history(t);
  stale.git(['merge', '-q', '--no-ff', '-m', 'Merge pull request #2', 'feature']);
  const mergeStale = stale.git(['rev-parse', 'HEAD']).trim();
  const headStale = stale.git(['rev-parse', 'feature']).trim();
  const refused = await decide(pushEnv(mergeStale), { git: stale.git, api: apiFor({ runs: green(headStale) }) });
  assert.equal(refused.heavy, true);
  assert.match(refused.reason, /tree differs/);

  // A fast-forward or squash lands one parent: no recorded head to compare.
  const single = history(t);
  assert.match((await decide(pushEnv(single.c1), { git: single.git, api: apiFor({ runs: green(single.c0) }) })).reason, /1 parents/);

  // Same tree, but the head does not contain main's previous tip: equality could be a coincidence, so it is not proof.
  const odd = history(t);
  const tree = odd.git(['rev-parse', `${odd.c1}^{tree}`]).trim();
  const lookalike = odd.git(['commit-tree', tree, '-p', odd.c0, '-m', 'independent head with the same tree']).trim();
  const merged = odd.git(['commit-tree', tree, '-p', odd.c1, '-p', lookalike, '-m', 'merge']).trim();
  const unrelated = await decide(pushEnv(merged), { git: odd.git, api: apiFor({ runs: green(lookalike) }) });
  assert.equal(unrelated.heavy, true);
  assert.match(unrelated.reason, /does not contain the previous main tip/);

  // An octopus merge records three parents.
  const three = odd.git(['commit-tree', tree, '-p', odd.c1, '-p', lookalike, '-p', odd.c0, '-m', 'octopus']).trim();
  assert.match((await decide(pushEnv(three), { git: odd.git, api: apiFor({ runs: green(lookalike) }) })).reason, /3 parents/);
});

test('required-check list matches the ruleset, the jobs API check is strict, and skipped is never success', () => {
  const required = ruleset.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.map(c => c.context);
  assert.deepEqual([...requiredChecks].sort(), [...required].sort());
  assert.equal(allRequiredPassed(jobsOf().jobs), true);
  for (const bad of [undefined, null, [], 'x', jobsOf({ verify: 'skipped' }).jobs, jobsOf({ image: 'neutral' }).jobs,
    [...jobsOf().jobs, { name: 'verify', status: 'completed', conclusion: 'failure' }], jobsOf().jobs.map(j => ({ ...j, status: 'in_progress' }))]) assert.equal(allRequiredPassed(bad), false);
  const mutated = [...requiredChecks]; mutated.pop();
  assert.notDeepEqual([...mutated].sort(), [...required].sort(), 'control: a shortened list would be caught by the comparison above');
});

test('the API reader accepts only the fixed host, needs a token, and does not follow redirects', async () => {
  const calls = [];
  const request = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: 1 }) }; };
  const good = { GH_TOKEN: 'synthetic-token', GITHUB_API_URL: 'https://api.github.com' };
  assert.deepEqual(await githubApi(good, request)('/repos/o/r/actions/runs/1/jobs'), { ok: 1 });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/runs/1/jobs');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(githubApi({ ...good, GITHUB_API_URL: 'https://evil.example' }, request)('/x'));
  await assert.rejects(githubApi({ GITHUB_API_URL: good.GITHUB_API_URL }, request)('/x'));
  await assert.rejects(githubApi(good, async () => ({ ok: false, status: 500 }))('/x'), /500/);
});

test('main writes both outputs and a summary that names no value beyond ids', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-out-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const GITHUB_OUTPUT = join(dir, 'output'), GITHUB_STEP_SUMMARY = join(dir, 'summary');
  writeFileSync(GITHUB_OUTPUT, ''); writeFileSync(GITHUB_STEP_SUMMARY, '');
  const result = await main({ ...pushEnv('a'.repeat(40)), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, GH_TOKEN: 'synthetic-token' }, { git: () => { throw new Error('x'); }, api: async () => { throw new Error('x'); } });
  assert.equal(result.heavy, true);
  assert.equal(readFileSync(GITHUB_OUTPUT, 'utf8'), 'heavy=true\nguards=true\nterraform=true\narchive=true\n');
  await assert.rejects(main({ ...pushEnv('a'.repeat(40)) }, { git: () => { throw new Error('x'); }, api: async () => { throw new Error('x'); } }), /GITHUB_OUTPUT/, 'no output file must fail the step, so `changes` fails and every job runs');
  assert.doesNotMatch(readFileSync(GITHUB_STEP_SUMMARY, 'utf8'), /synthetic-token/);
});

// ---- ci.yml: who may be skipped, and by what ----

const CONDITION = { verify: guardsCondition, 'service-memory': heavyCondition, 'service-postgres': heavyCondition, 'service-postgres-s3': heavyCondition,
  browser: heavyCondition, terraform: terraformCondition, 'terraform-lint': terraformCondition };
/** The steps of verify that only a code change needs. The install and the two guards that read documentation (test:infra, test:ci-config) are not here and carry no condition: test:infra loads the backend's config loader, which needs zod. */
const HEAVY_STEPS = ['Typecheck', 'Lint', 'Workspace tests', 'Production builds', 'Published FHIR Genomics IG validation (synthetic only)',
  'Frontend chunk budget', 'Knowledge directory loads under production rules'];
const lines = (block, key) => block.match(new RegExp(`^    ${key}:.*$`, 'gm')) ?? [];

/** The documentation-only run of verify: which steps it keeps. */
function verifyStepProblems(text) {
  const problems = [];
  const steps = jobOf(text, 'verify').split(/^      - /m).slice(1);
  const named = name => steps.find(st => st.startsWith(`name: ${name}\n`)) ?? '';
  for (const name of HEAVY_STEPS) if (!named(name).includes(`        if: ${heavyStepCondition}\n`)) problems.push(`${name} must be skipped by the heavy step condition`);
  for (const st of steps) {
    const conditions = st.match(/^        if:.*$/gm) ?? [];
    const name = st.match(/^name: (.*)$/m)?.[1];
    if (conditions.length && !HEAVY_STEPS.includes(name)) problems.push(`step ${name ?? st.split('\n')[0]} may not be conditional`);
    if (conditions.length > 1 || (conditions.length && conditions[0] !== `        if: ${heavyStepCondition}`)) problems.push(`step ${name} carries a condition other than the heavy step condition`);
  }
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm test:infra', 'pnpm test:ci-config']) {
    const step = steps.filter(st => st.includes(`run: ${command}\n`) || st.endsWith(`run: ${command}`));
    if (step.length !== 1 || /^        (?:if|continue-on-error):/m.test(step[0])) problems.push(`${command} must run, unconditionally, in every verify run`);
  }
  return problems;
}

/** Everything a skipped job could be mistaken for: only the named jobs carry the scope condition, nothing else does, and `changes` is built as reviewed. */
export function scopeProblems(text) {
  const problems = [];
  const need = (ok, label) => { if (!ok) problems.push(label); };
  for (const [key, condition] of Object.entries(CONDITION)) {
    const block = jobOf(text, key);
    need(block !== '', `${key} exists`);
    need(lines(block, 'if').join('\n') === `    if: ${condition}`, `${key} is skipped only by its own scope condition`);
    need(lines(block, 'needs').join('\n') === (key.startsWith('service-') || ['verify', 'browser', 'terraform', 'terraform-lint'].includes(key) ? '    needs: changes' : ''), `${key} waits for changes`);
  }
  problems.push(...verifyStepProblems(text));
  const image = jobOf(text, 'image');
  need(lines(image, 'if').join('\n') === `    if: ${archiveCondition}` && lines(image, 'needs').join('\n') === '    needs: changes', 'image is skipped only by the archive condition');
  const scan = jobOf(text, 'secret-scan');
  need(scan !== '' && lines(scan, 'if').length === 0 && lines(scan, 'needs').length === 0, 'secret-scan never waits for or is skipped by the scope');
  need(/^    if: always\(\) && !\(needs\.service-memory\.result == 'skipped'/m.test(jobOf(text, 'database-and-storage')), 'the joining gate is skipped only with all producers');
  const changes = jobOf(text, 'changes');
  need(changes !== '', 'the changes job exists');
  need(/^    permissions:\n      contents: read\n      actions: read\n/m.test(changes), 'changes reads contents and actions only');
  need(lines(changes, 'needs').length === 0 && lines(changes, 'continue-on-error').length === 0 && lines(changes, 'if').length === 0, 'changes depends on nothing, always runs and cannot swallow failure');
  need(/fetch-depth: 0\n/.test(changes) && /persist-credentials: false\n/.test(changes), 'changes sees the history it compares and keeps no credentials');
  need(/^        run: node \.github\/ci\/scope\.mjs$/m.test(changes) && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(changes), 'changes runs scope.mjs with the job token');
  need(changes.includes('          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n') && changes.includes('          BEFORE_SHA: ${{ github.event.before }}\n'), 'changes passes the pull-request head and the previous main tip');
  const outputs = changes.match(/^    outputs:\n((?: {6}\S.*\n)+)/m)?.[1].trimEnd().split('\n') ?? [];
  need(JSON.stringify(outputs) === JSON.stringify(['heavy', 'guards', 'terraform', 'archive'].map(k => `      ${k}: \${{ steps.scope.outputs.${k} }}`)), 'changes exposes exactly the four outputs');
  const everyUse = [...text.matchAll(/needs\.changes\.[^\s)]*/g)].map(m => m[0]);
  need(everyUse.every(u => ['heavy', 'guards', 'terraform', 'archive'].map(k => `needs.changes.outputs.${k}`).concat('needs.changes.result').includes(u)), 'jobs read only the four outputs and the result');
  return problems;
}

test('only the reviewed jobs can be skipped by the scope, and secret-scan never is', () => {
  assert.deepEqual(scopeProblems(workflow), []);
});

test('the scope structure check turns red for each way a gate could be skipped wrongly (controls)', () => {
  const verify = jobOf(workflow, 'verify');
  const terraform = jobOf(workflow, 'terraform');
  const scan = jobOf(workflow, 'secret-scan');
  const changes = jobOf(workflow, 'changes');
  const swap = (block, from, to) => { assert.ok(block.includes(from), from); return workflow.replace(block, block.replace(from, to)); };
  const mutations = {
    'a failed changes job skips the gate': swap(verify, " || needs.changes.result == 'failure'", ''),
    'implicit success() skips on a changes failure': swap(verify, '!cancelled() && (', 'success() && ('),
    'draft logic in a job condition': swap(verify, "needs.changes.outputs.heavy == 'true'", "needs.changes.outputs.heavy == 'true' && github.event.pull_request.draft == false"),
    'a gate that no longer waits for changes': swap(terraform, '    needs: changes\n', ''),
    'secret-scan skipped': swap(scan, '    name: secret-scan\n', "    name: secret-scan\n    if: ${{ needs.changes.outputs.heavy == 'true' }}\n"),
    'changes can write': swap(changes, 'actions: read', 'actions: write'),
    'changes sees only a shallow history': swap(changes, 'fetch-depth: 0', 'fetch-depth: 1'),
    'changes is optional': swap(changes, '    timeout-minutes: 5\n', '    timeout-minutes: 5\n    continue-on-error: true\n'),
    'another script decides': swap(changes, 'node .github/ci/scope.mjs', 'node .github/ci/other.mjs'),
    'a fifth output leaks in': swap(changes, '      archive:', '      docs: ${{ steps.scope.outputs.docs }}\n      archive:'),
    'the joining gate always runs even with nothing to join (old shape)': workflow.replace(/    if: always\(\) && !\(needs\.service-memory.*\n/, '    if: always()\n'),
    'a documentation-only run skips the docs guard': workflow.replace('      - name: Terraform security tripwire\n        run: pnpm test:infra', `      - name: Terraform security tripwire\n        if: \${{ needs.changes.outputs.heavy == 'true' }}\n        run: pnpm test:infra`),
    'the CI configuration guard is skipped': workflow.replace('        run: pnpm test:ci-config', `        if: \${{ needs.changes.outputs.heavy == 'true' }}\n        run: pnpm test:ci-config`),
    'the install is skipped on a documentation-only change, which test:infra cannot survive': swap(verify, '      - name: Install locked dependencies\n', `      - name: Install locked dependencies\n        if: \${{ needs.changes.outputs.heavy == 'true' || needs.changes.result == 'failure' }}\n`),
    'typecheck is no longer skipped when only documentation changed': swap(verify, `      - name: Typecheck\n        if: \${{ needs.changes.outputs.heavy == 'true' || needs.changes.result == 'failure' }}\n`, '      - name: Typecheck\n'),
    'verify is skipped by the heavy output (a documentation-only change would then skip the docs guards)': swap(verify, "needs.changes.outputs.guards == 'true'", "needs.changes.outputs.heavy == 'true'"),
    'terraform follows the heavy output': swap(terraform, "needs.changes.outputs.terraform == 'true'", "needs.changes.outputs.heavy == 'true'"),
  };
  for (const [label, text] of Object.entries(mutations)) {
    assert.notEqual(text, workflow, `${label}: the mutation must change the workflow`);
    assert.ok(scopeProblems(text).length > 0, `${label} must be reported`);
  }
});

test('the scope conditions keep the failure arm and the status function that make a crashed changes job run everything', () => {
  // `!cancelled()` stops GitHub adding an implicit success(), and the failure arm turns a crashed changes job into "run". Both are pinned as text
  // here and by scopeProblems above, because GitHub's evaluation itself cannot run offline (reported in docs/ops/ci-cd.md).
  for (const condition of [heavyCondition, guardsCondition, terraformCondition, archiveCondition]) {
    assert.ok(condition.startsWith('${{ !cancelled() && (') && condition.includes("|| needs.changes.result == 'failure') }}"));
  }
  assert.ok(gateCondition.startsWith('always() && !('));
});

// ---- documentation-only and no-infrastructure scopes ----

test('docsPath accepts only markdown under docs/ and in the repository root', () => {
  for (const ok of ['docs/STATUS.md', 'docs/ops/ci-cd.md', 'docs/design/previews/notes.md', 'README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md']) assert.equal(docsPath(ok), true, ok);
  for (const no of ['docs/clinical-validation/report-lookup-offline-v1-results.json', 'docs/design/previews/landing-mobile-375.png', 'docs/.gitkeep', 'docs/x.MD', 'docs/x.md.bak',
    'docs/', 'docs', 'docs.md/x.ts', 'xdocs/a.md', 'apps/backend/README.md', 'knowledge/lab-report-reader/v2-handoff/ORIGIN.md', '.github/pull_request_template.md',
    '.claude/skills/speckit-plan/SKILL.md', 'specs/002-signed-image-release/spec.md', 'packages/smart-pilot/test/fhir-ig/README.md', 'docs/a\0b.md', 'a.md\0.ts']) assert.equal(docsPath(no), false, no);
});

test('classify refuses a list it cannot trust, and separates documentation, code and infrastructure', () => {
  for (const bad of [null, undefined, 'docs/a.md', [], [''], [7], ['/etc/passwd'], ['docs/../apps/a.md'], ['../outside.md']]) assert.equal(classify(bad), null, JSON.stringify(bad));
  assert.deepEqual(classify(['docs/a.md', 'README.md']), { docsOnly: true, terraform: false });
  assert.deepEqual(classify(['docs/a.md', 'apps/backend/src/a.ts']), { docsOnly: false, terraform: false });
  assert.deepEqual(classify(['docs/clinical-validation/r.json']), { docsOnly: false, terraform: false });
  assert.deepEqual(classify(['apps/frontend/src/a.tsx', 'infrastructure/terraform/api.tf']), { docsOnly: false, terraform: true });
  for (const infra of ['infrastructure/docker/api.Dockerfile', 'infrastructure/lambda/x/index.js', '.tflint.hcl', '.github/workflows/ci.yml', '.github/ci/guard.test.mjs']) {
    assert.equal(classify([infra]).terraform, true, infra);
  }
  for (const app of ['apps/backend/src/a.ts', 'pnpm-lock.yaml', 'package.json', 'scripts/staging/run-task.mjs', 'knowledge/cpic/a.json']) assert.equal(classify([app]).terraform, false, app);
});

/** A pull request the way GitHub checks it out: the head merged into a base that moved on, parents [base, head]. */
function pullRequest(t, { base = {}, change }) {
  const r = repo(t);
  r.commit('base.txt', 'base', 'base');
  for (const [file, text] of Object.entries(base)) r.commit(file, text, 'base ' + file);
  r.git(['checkout', '-q', '-b', 'feature']);
  change(r);
  const head = r.git(['rev-parse', 'HEAD']).trim();
  r.git(['checkout', '-q', 'main']);
  const before = r.commit('elsewhere.txt', 'main moved', 'main moves on');
  r.git(['checkout', '-q', '-b', 'merge-ref']);
  r.git(['merge', '-q', '--no-ff', '-m', 'test merge', 'feature']);
  return { ...r, head, before, merge: r.git(['rev-parse', 'HEAD']).trim() };
}
const prEnv = h => ({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge', GITHUB_SHA: h.merge, GITHUB_REPOSITORY: repository, PR_HEAD_SHA: h.head, RELEASE_ENABLED: 'false' });
const noApi = { api: async () => { throw new Error('a pull-request run must not call the API'); } };
const scope = r => [r.heavy, r.guards, r.terraform, r.archive];

test('a pull request that changes only documentation runs only the docs guards; any other file brings the whole run back', async t => {
  const docs = pullRequest(t, { change: r => { r.commit('docs/ops/new-note.md', 'n', 'doc'); r.commit('README.md', 'r', 'readme'); } });
  assert.deepEqual(changedFiles(prEnv(docs), docs.git).sort(), ['README.md', 'docs/ops/new-note.md']);
  const result = await decide(prEnv(docs), { git: docs.git, ...noApi });
  assert.deepEqual(scope(result), [false, true, false, false], result.reason);
  assert.match(result.reason, /only documentation changed \(2 files/);

  const cases = {
    'a source file beside documentation': [r => { r.commit('docs/a.md', 'a', 'doc'); r.commit('apps/backend/src/a.ts', 'a', 'code'); }, [true, true, false, true]],
    'a docs JSON file': [r => r.commit('docs/clinical-validation/r.json', '{}', 'json'), [true, true, false, true]],
    'markdown outside docs that tests read': [r => r.commit('knowledge/lab-report-reader/v2-handoff/ORIGIN.md', 'o', 'md'), [true, true, false, true]],
    'a workflow change': [r => r.commit('.github/workflows/ci.yml', 'x', 'ci'), [true, true, true, true]],
    'a terraform change': [r => r.commit('infrastructure/terraform/a.tf', 'x', 'tf'), [true, true, true, true]],
    'an application-only change skips only terraform': [r => r.commit('apps/frontend/src/a.tsx', 'x', 'fe'), [true, true, false, true]],
  };
  for (const [label, [change, expected]] of Object.entries(cases)) {
    const h = pullRequest(t, { change });
    assert.deepEqual(scope(await decide(prEnv(h), { git: h.git, ...noApi })), expected, label);
  }
});

test('a rename out of code into documentation is not documentation only, and a deleted document is', async t => {
  const moved = pullRequest(t, { base: { 'apps/x.ts': 'code that is lost if the move goes unchecked' }, change: r => { mkdirSync(join(r.dir, 'docs'), { recursive: true }); r.git(['mv', 'apps/x.ts', 'docs/x.md']); r.git(['commit', '-q', '-m', 'move']); } });
  assert.deepEqual(changedFiles(prEnv(moved), moved.git).sort(), ['apps/x.ts', 'docs/x.md'], 'a rename must list both paths');
  assert.deepEqual(scope(await decide(prEnv(moved), { git: moved.git, ...noApi })), [true, true, false, true]);
  const removed = pullRequest(t, { base: { 'docs/old.md': 'old' }, change: r => { r.git(['rm', '-q', 'docs/old.md']); r.git(['commit', '-q', '-m', 'remove']); } });
  assert.deepEqual(scope(await decide(prEnv(removed), { git: removed.git, ...noApi })), [false, true, false, false]);
});

test('the changed files are refused when the checkout is not the test merge the event names (controls)', async t => {
  const h = pullRequest(t, { change: r => r.commit('docs/a.md', 'a', 'doc') });
  const everything = async env => assert.deepEqual(scope(await decide(env, { git: h.git, ...noApi })), [true, true, true, true]);
  await everything({ ...prEnv(h), PR_HEAD_SHA: '0'.repeat(40) });
  await everything({ ...prEnv(h), PR_HEAD_SHA: undefined });
  await everything({ ...prEnv(h), PR_HEAD_SHA: h.before });
  // GitHub falls back to checking out the head itself when the test merge cannot be built: one parent, no base to compare with.
  await everything({ ...prEnv(h), GITHUB_SHA: h.head });
  await everything({ ...prEnv(h), GITHUB_EVENT_NAME: 'merge_group' });
  await everything({ ...prEnv(h), GITHUB_EVENT_NAME: 'schedule' });
  assert.equal(changedFiles({ ...prEnv(h), GITHUB_EVENT_NAME: 'merge_group' }, h.git), null);
});

test('a push to main that cannot reuse a verified tree is still classified by what the push changed', async t => {
  const h = pullRequest(t, { change: r => r.commit('docs/a.md', 'a', 'doc') });
  h.git(['checkout', '-q', 'main']);
  h.git(['merge', '-q', '--no-ff', '-m', 'Merge pull request #3', 'feature']);
  const merge = h.git(['rev-parse', 'HEAD']).trim();
  const push = { ...pushEnv(merge), BEFORE_SHA: h.before };
  const none = { api: async () => ({ workflow_runs: [] }) };
  assert.deepEqual(scope(await decide(push, { git: h.git, ...none })), [false, true, false, false], 'documentation only, no verified run to reuse');
  assert.deepEqual(scope(await decide({ ...push, RELEASE_ENABLED: 'true' }, { git: h.git, ...none })), [false, true, false, true], 'an armed release still gets its archive from a push to main');
});

test('a push to main with no usable previous tip runs everything (controls)', async t => {
  const h = pullRequest(t, { change: r => r.commit('docs/a.md', 'a', 'doc') });
  h.git(['checkout', '-q', 'main']);
  h.git(['merge', '-q', '--no-ff', '-m', 'Merge pull request #4', 'feature']);
  const merge = h.git(['rev-parse', 'HEAD']).trim();
  const none = { api: async () => ({ workflow_runs: [] }) };
  for (const before of [undefined, '', '0'.repeat(40), 'f'.repeat(40), 'not-a-sha']) {
    assert.deepEqual(scope(await decide({ ...pushEnv(merge), BEFORE_SHA: before }, { git: h.git, ...none })), [true, true, true, true], String(before));
  }
});

test('the only code that reads documentation is code the documentation-only run still executes', () => {
  // Heuristic, not proof: it sees literal docs paths beside a file API, not computed paths. A new reader turns it red; then either add its suite to the
  // steps a documentation-only verify keeps, or stop treating that path as documentation (docsPath in scope.mjs).
  const files = execFileSync('git', ['ls-files', '-z', 'apps', 'packages', 'scripts', 'infrastructure', '.github'], { encoding: 'utf8', cwd: new URL('../../', import.meta.url) })
    .split('\0').filter(f => /\.(ts|tsx|js|cjs|mjs)$/.test(f));
  assert.ok(files.length > 500, 'a scan that finds almost no source proves nothing');
  const reads = /(readFile|readFileSync|readdir|readdirSync|existsSync|statSync|createReadStream|new URL\(|path:)/;
  const docs = /(?:^|[^\w])docs\/[\w.-]|['"]docs['"]/;
  const found = files.filter(f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8').split('\n').some(l => !/^\s*(\/\/|\*|\/\*|#)/.test(l) && docs.test(l) && reads.test(l))).sort();
  assert.deepEqual(found, [
    'apps/frontend/e2e/landing.spec.ts', // writes PNG screenshots into docs/design/previews; reads no documentation, and a PNG is not a docsPath
    'infrastructure/terraform/guard.test.mjs', // docs/ops/break-glass.md (pnpm test:infra)
    'infrastructure/terraform/staging.guard.test.mjs', // docs/ops/staging-plan-review.md (pnpm test:infra)
    'scripts/status-index.mjs', // docs/status/ fragments (pnpm test:ci-config, status-fragments.test.mjs)
  ]);
});
