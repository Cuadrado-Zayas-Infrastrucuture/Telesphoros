// Decides how much of ci.yml a run must do, so a run never repeats work that an earlier run already proved.
// The `changes` job runs this first; every other job reads its two outputs and nothing else:
//   heavy  'true'  verify, the service path, browser, terraform and terraform-lint run
//   archive 'true' the image job builds the OCI archive (it also feeds release-image, so it is kept whenever a release is armed)
// Every doubt resolves to 'true'. A run that cannot prove it may skip, does everything.
//
// Tree reuse (post-merge push to main). The ruleset requires a pull request to be up to date with main before it merges, so the merged
// head P contains main's previous tip B, and the merge commit M that lands on main has exactly P's tree. The pull-request run tested
// the merge of P with the main of that moment, which is also P's tree (that main is an ancestor of B, hence of P). M is therefore the
// same files that run already verified. The push run is allowed to skip only when ALL of this holds, each proved here and not assumed:
//   1. the event is a push to refs/heads/main;
//   2. M is a two-parent merge commit (parents B and P); a squash or rebase merge has no recorded head, so it runs everything;
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
const everything = reason => ({ heavy: true, archive: true, reason });

/** { sha, parents } of a commit, from `git rev-list --parents -n1`. */
export function parentsOf(git, sha) {
  const [self, ...parents] = git(['rev-list', '--parents', '-n1', sha]).trim().split(' ');
  if (self !== sha || ![self, ...parents].every(s => sha40.test(s))) throw new Error('unreadable commit');
  return parents;
}

/** True when every required check is a completed, successful job of the run (a skipped or missing one is not). */
export function allRequiredPassed(jobs) {
  if (!Array.isArray(jobs)) return false;
  return requiredChecks.every(name => {
    const same = jobs.filter(j => j?.name === name);
    return same.length > 0 && same.every(j => j.status === 'completed' && j.conclusion === 'success');
  });
}

/**
 * Reuse decision for a push to main. `api(path)` returns parsed JSON or throws; `git(args)` returns stdout or throws.
 * Returns { heavy, archive, reason } and never throws: an error is a reason to run everything.
 */
export async function decide(env, { git, api }) {
  try {
    const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository } = env;
    const releaseArmed = env.RELEASE_ENABLED === 'true';
    if (event !== 'push' || ref !== 'refs/heads/main') return everything(`${event} on ${ref} is not a push to main`);
    if (!sha40.test(sha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return everything('run identity is unreadable');
    const parents = parentsOf(git, sha);
    if (parents.length !== 2) return everything(`${parents.length} parents: only a two-parent merge commit records the pull-request head`);
    const [base, head] = parents;
    const tree = git(['rev-parse', `${sha}^{tree}`]).trim();
    if (!sha40.test(tree) || git(['rev-parse', `${head}^{tree}`]).trim() !== tree) return everything('the merge commit tree differs from the pull-request head tree');
    try { git(['merge-base', '--is-ancestor', base, head]); } catch { return everything('the pull-request head does not contain the previous main tip'); }
    const listed = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=30`);
    const candidates = (listed?.workflow_runs ?? [])
      .filter(r => r?.head_sha === head && r.event === 'pull_request' && r.status === 'completed' && r.conclusion === 'success'
        && r.head_repository?.full_name === repository && r.repository?.full_name === repository && Number.isSafeInteger(r.id))
      .slice(0, 5);
    for (const run of candidates) {
      const jobs = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (allRequiredPassed(jobs?.jobs)) {
        return { heavy: false, archive: releaseArmed, reason: `tree ${tree} was verified by pull-request run ${run.id} at head ${head}; all ${requiredChecks.length} required checks succeeded there` };
      }
    }
    return everything(`no successful pull-request run with all required checks found for head ${head}`);
  } catch (error) {
    return everything(`could not prove reuse (${error?.message ?? 'error'})`);
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
  const lines = [`heavy=${result.heavy}`, `archive=${result.archive}`];
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  const summary = `Scope: heavy=${result.heavy}, archive=${result.archive}. ${result.reason}.`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
  process.stdout.write(summary + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
