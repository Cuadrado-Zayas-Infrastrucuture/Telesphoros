// Decides how much of ci.yml a run must do, so a run never repeats work that an earlier run already proved.
// The `changes` job runs this first; every other job reads its outputs and nothing else:
//   heavy     'true'  the service path (service-memory, service-postgres, service-postgres-s3, database-and-storage) and browser run, and verify runs all of its steps
//   guards    'true'  verify runs at all; with heavy 'false' it runs only the two guards that read documentation (test:infra, test:ci-config)
//   terraform 'true'  terraform and terraform-lint run
//   postgres  'true'  the standalone PostgreSQL profile (service-postgres) runs, and the joining gate expects all three backend profiles; 'false' expects
//                     memory and PostgreSQL + S3 only (service-profiles.mjs reads this output, only an explicit success of `changes` with 'false' narrows it)
//   archive   'true'  the image job builds the OCI archive (it also feeds release-image, so it is kept whenever a release is armed)
// Every doubt resolves to 'true'. A run that cannot prove it may skip, does everything.
//
// Three reasons a run may do less, in this order:
//   1. tree reuse after a merge (below): the same tree already passed all six required checks;
//   2. documentation only: every changed file is docs/**/*.md or a *.md in the repository root (see docsPath for why that narrow);
//   3. no infrastructure change: terraform and terraform-lint are skipped when nothing under infrastructure/, .tflint.hcl or .github/ changed;
//   4. the standalone PostgreSQL profile runs only in the nightly (event schedule) and in a manual run (workflow_dispatch), and in any run that could not be
//      narrowed. A nightly is itself skipped when an earlier nightly already passed everything, service-postgres included, at the same commit of main.
//
// Tree reuse (post-merge push to main). The ruleset requires a pull request to be up to date with main before it merges, so the merged
// head P contains main's previous tip B, and the merge commit M that lands on main has exactly P's tree. The pull-request run tested
// the merge of P with the main of that moment, which is also P's tree (that main is an ancestor of B, hence of P). M is therefore the
// same files that run already verified. The push run is allowed to skip only when ALL of this holds, each proved here and not assumed:
//   1. the event is a push to refs/heads/main;
//   2. M is a two-parent merge commit (parents B and P); a squash or rebase merge has no recorded head, so reuse is refused (the later rules may still apply);
//   3. tree(M) equals tree(P) and P contains B (git merge-base --is-ancestor B P);
//   4. a completed run of THIS workflow on this repository (not a fork) exists for event pull_request with head_sha P and conclusion success;
//   5. that run's latest attempt shows each required check as a job that completed with conclusion success. A skipped job does not count:
//      a draft or documentation-only run reports every check as skipped, and a skipped check proves nothing about code.
// docs/ops/ci-cd.md ("Skipping work: what is proved") states the same list for people.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The six checks the ruleset requires. guard tests pin this list to .github/rulesets/main.json. */
export const requiredChecks = ['verify', 'database-and-storage', 'browser', 'terraform', 'secret-scan', 'image'];

const sha40 = /^[a-f0-9]{40}$/;
const everything = reason => ({ heavy: true, guards: true, terraform: true, postgres: true, archive: true, reason });
const reused = (archive, reason) => ({ heavy: false, guards: false, terraform: false, postgres: false, archive, reason });
const documentation = (archive, reason) => ({ heavy: false, guards: true, terraform: false, postgres: false, archive, reason });

/**
 * A path whose change cannot alter what the heavy jobs prove. Deliberately narrow. Markdown elsewhere is read by tests
 * (knowledge/lab-report-reader/v2-handoff/ORIGIN.md by handoff-import.spec.ts), and docs/ holds JSON and PNG files that are not documentation.
 * The only code that reads documentation is test:infra (docs/ops/break-glass.md, docs/ops/staging-plan-review.md) and test:ci-config
 * (docs/status/, CLAUDE.md); scope.test.mjs lists the readers, so a new one turns the guard red.
 */
export const docsPath = p => /^docs\/(?:[^/\0]+\/)*[^/\0]+\.md$/.test(p) || /^[^/\0]+\.md$/.test(p);
/** Paths the terraform and terraform-lint jobs can depend on (the roots, the lambda source, the lint config, the workflow itself). */
export const terraformPath = p => p.startsWith('infrastructure/') || p === '.tflint.hcl' || p.startsWith('.github/');

/** { docsOnly, terraform } for a list of changed paths, or null when the list cannot be trusted (empty, or not strings). */
export function classify(files) {
  if (!Array.isArray(files) || files.length === 0 || files.some(f => typeof f !== 'string' || f === '' || f.startsWith('/') || f.split('/').includes('..'))) return null;
  return { docsOnly: files.every(docsPath), terraform: files.some(terraformPath) };
}

/** The paths this run changes, or null when they cannot be read with certainty (the caller then runs everything). */
export function changedFiles(env, git) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha } = env;
  let from;
  if (event === 'pull_request') {
    // The checkout is GitHub's test merge of the head into the base. If it could not be built the checkout is the head itself, whose parent is
    // not the base, so the shape is checked: two parents, the second being the head the event names.
    const parents = parentsOf(git, sha);
    if (parents.length !== 2 || !sha40.test(env.PR_HEAD_SHA ?? '') || parents[1] !== env.PR_HEAD_SHA) return null;
    from = parents[0];
  } else if (event === 'push' && ref === 'refs/heads/main') {
    from = env.BEFORE_SHA;
    if (!sha40.test(from ?? '') || /^0+$/.test(from)) return null;
    git(['cat-file', '-e', `${from}^{commit}`]);
  } else return null;
  const names = git(['diff', '--name-only', '-z', '--no-renames', from, sha]).split('\0').filter(Boolean);
  return names.length ? names : null;
}

/** { sha, parents } of a commit, from `git rev-list --parents -n1`. */
export function parentsOf(git, sha) {
  const [self, ...parents] = git(['rev-list', '--parents', '-n1', sha]).trim().split(' ');
  if (self !== sha || ![self, ...parents].every(s => sha40.test(s))) throw new Error('unreadable commit');
  return parents;
}

/** True when every required check is a completed, successful job of the run (a skipped or missing one is not). */
export function allRequiredPassed(jobs, names = requiredChecks) {
  if (!Array.isArray(jobs)) return false;
  return names.every(name => {
    const same = jobs.filter(j => j?.name === name);
    return same.length > 0 && same.every(j => j.status === 'completed' && j.conclusion === 'success');
  });
}

/** Proof for tree reuse (conditions 1 to 5 in the header). Returns the reuse result, or { reason } naming the first proof that is missing. */
async function proveReuse(env, { git, api }) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository } = env;
  if (event !== 'push' || ref !== 'refs/heads/main') return { reason: `${event} on ${ref} is not a push to main` };
  if (!sha40.test(sha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return { reason: 'run identity is unreadable' };
  const parents = parentsOf(git, sha);
  if (parents.length !== 2) return { reason: `${parents.length} parents: only a two-parent merge commit records the pull-request head` };
  const [base, head] = parents;
  const tree = git(['rev-parse', `${sha}^{tree}`]).trim();
  if (!sha40.test(tree) || git(['rev-parse', `${head}^{tree}`]).trim() !== tree) return { reason: 'the merge commit tree differs from the pull-request head tree' };
  try { git(['merge-base', '--is-ancestor', base, head]); } catch { return { reason: 'the pull-request head does not contain the previous main tip' }; }
  const run = await findVerifiedRun(api, repository, { event: 'pull_request', head, required: requiredChecks });
  if (run) return reused(env.RELEASE_ENABLED === 'true', `tree ${tree} was verified by pull-request run ${run.id} at head ${head}; all ${requiredChecks.length} required checks succeeded there`);
  return { reason: `no successful pull-request run with all required checks found for head ${head}` };
}

/** The newest completed, successful run of ci.yml in this repository for `event` at `head`, whose latest attempt shows every `required` job as success. */
async function findVerifiedRun(api, repository, { event, head, required }) {
  const listed = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${head}&event=${event}&per_page=30`);
  const candidates = (listed?.workflow_runs ?? [])
    .filter(r => r?.head_sha === head && r.event === event && r.status === 'completed' && r.conclusion === 'success'
      && r.head_repository?.full_name === repository && r.repository?.full_name === repository && Number.isSafeInteger(r.id))
    .slice(0, 10);
  for (const run of candidates) {
    const jobs = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (allRequiredPassed(jobs?.jobs, required)) return run;
  }
  return null;
}

/** The nightly does nothing when an earlier nightly already passed every required check and the standalone PostgreSQL profile at this commit of main. */
async function proveNightly(env, { api }) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository } = env;
  if (event !== 'schedule' || ref !== 'refs/heads/main') return { reason: `${event} on ${ref} is not the nightly` };
  if (!sha40.test(sha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return { reason: 'run identity is unreadable' };
  const run = await findVerifiedRun(api, repository, { event: 'schedule', head: sha, required: [...requiredChecks, 'service-postgres'] });
  if (run) return { heavy: false, guards: false, terraform: false, postgres: false, archive: false, reason: `main at ${sha} already passed the full nightly run ${run.id}; nothing to repeat` };
  return { reason: `no earlier nightly passed every check and the PostgreSQL profile at ${sha}` };
}

/**
 * The scope of this run. `api(path)` returns parsed JSON or throws; `git(args)` returns stdout or throws.
 * Returns { heavy, guards, terraform, archive, reason } and never throws: an error is a reason to run everything.
 */
export async function decide(env, deps) {
  try {
    if (env.GITHUB_EVENT_NAME === 'schedule') {
      const nightly = await proveNightly(env, deps);
      return nightly.heavy !== undefined ? nightly : everything(`nightly: ${nightly.reason}`);
    }
    const proof = await proveReuse(env, deps);
    if (proof.heavy !== undefined) return proof;
    const files = changedFiles(env, deps.git);
    const kind = classify(files);
    if (!kind) return everything(`${proof.reason}; the changed files cannot be read with certainty`);
    const releaseArmed = env.RELEASE_ENABLED === 'true' && env.GITHUB_EVENT_NAME === 'push';
    if (kind.docsOnly) return documentation(releaseArmed, `only documentation changed (${files.length} file${files.length === 1 ? '' : 's'}: docs/**/*.md or a root *.md); ${proof.reason}`);
    const area = kind.terraform ? 'infrastructure, the lint configuration or the workflow changed' : 'nothing under infrastructure/, .tflint.hcl or .github/ changed, so the terraform jobs are skipped';
    return { ...everything(`${files.length} files changed; ${area}; the standalone PostgreSQL profile is left to the nightly; ${proof.reason}`), terraform: kind.terraform, postgres: false };
  } catch (error) {
    return everything(`could not prove a smaller scope (${error?.message ?? 'error'})`);
  }
}

/** GitHub REST read, same shape as the budget request in service-deadline.mjs: fixed host, no redirects, bounded wait. */
export function githubApi(env, request = fetch) {
  return async path => {
    if (!env.GH_TOKEN || env.GITHUB_API_URL !== 'https://api.github.com') throw new Error('API access is not configured');
    const response = await request(env.GITHUB_API_URL + path, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`API answered ${response.status}`);
    return response.json();
  };
}

const gitCommand = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Entry point for the workflow: write the two outputs and a one-line summary. */
export async function main(env = process.env, deps = { git: gitCommand, api: githubApi(env) }) {
  const result = await decide(env, deps);
  const lines = ['heavy', 'guards', 'terraform', 'postgres', 'archive'].map(key => `${key}=${result[key]}`);
  // No output file means the jobs below would read empty strings and skip: fail the step instead, so `changes` fails and they all run.
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  const summary = `Scope: ${lines.join(', ')}. ${result.reason}.`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
  process.stdout.write(summary + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
