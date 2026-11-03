import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligible } from './staging-release.mjs';
const sha = 'a'.repeat(40);
const run = { conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, path: '.github/workflows/ci.yml', repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' } };
test('publish only successful same-repository push CI for current main', () => {
  assert.equal(eligible(run, 'owner/repo', sha), true);
  for (const change of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { event: 'pull_request' }, { head_branch: 'topic' }, { path: '.github/workflows/other.yml' }, { head_sha: 'bad' }, { head_repository: { full_name: 'fork/repo' } }, { repository: { full_name: 'other/repo' } }]) assert.equal(eligible({ ...run, ...change }, 'owner/repo', sha), false);
  assert.equal(eligible(run, 'owner/repo', 'b'.repeat(40)), false);
  assert.equal(eligible(null, 'owner/repo', sha), false);
});

import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ACCOUNT_ID = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/;
const jobs = text => Object.fromEntries((text.split(/^jobs:\s*$/m)[1] ?? '').split(/^ {2}(?=[a-z][a-z0-9_-]*:\s*$)/m).filter(j => /\S/.test(j)).map(j => [j.split(':')[0].trim(), j]));

/** What is wrong with a copy of the workflow (empty when nothing is); the controls below run it on broken copies. */
export function frontendWorkflowProblems(w) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const { build = '', publish = '' } = jobs(w);
  for (const text of ['workflows: [ci]', 'branches: [main]', "github.event.workflow_run.event == 'push'", 'github.event.workflow_run.head_repository.full_name == github.repository', "vars.STAGING_FRONTEND_AUTO_DEPLOY == 'true'", 'cancel-in-progress: false', 'ref: ${{ github.event.workflow_run.head_sha }}', 'aws cloudfront wait invalidation-completed', 'r.commit!==process.env.RELEASE_SHA']) need(w.includes(text), `the workflow must keep: ${text}`);
  // Build: installs and builds, behind the main gate, with no OIDC permission; it hands over one archive and its digest.
  need(build.includes('pnpm install --frozen-lockfile') && !/id-token/.test(build), 'build installs and builds, and never holds id-token');
  need((build.match(/if: steps.gate.outputs.publish == 'true'/g) ?? []).length === 4, 'every build step after the gate runs only when the gate says publish');
  need(build.includes('publish: ${{ steps.gate.outputs.publish }}') && build.includes('digest: ${{ steps.pack.outputs.digest }}'), 'build hands the gate decision and the archive digest to publish');
  // Publish: the only job with credentials; no package manager; it uploads only the archive build packed, then rechecks main.
  need(/^\s+id-token: write$/m.test(publish) && publish.includes('environment: staging-frontend') && publish.includes('needs: build') && publish.includes("if: needs.build.outputs.publish == 'true'"), 'publish holds id-token, in the staging-frontend environment, only after build says publish');
  need(!/pnpm|npm |yarn/.test(publish), 'publish runs no package manager');
  const digest = publish.indexOf('test "$(sha256sum "$RUNNER_TEMP/bundle/frontend-dist.tar" | cut -d\' \' -f1)" = "$DIST_DIGEST"');
  const creds = publish.indexOf('uses: aws-actions/configure-aws-credentials@');
  need(digest > 0 && creds > digest, 'publish checks the archive digest before it asks AWS for credentials');
  need(publish.indexOf('--require-current') > creds && publish.indexOf('--require-current') < publish.indexOf('publish-frontend.sh --yes'), 'publish rechecks current main just before uploading');
  need(publish.includes('allowed-account-ids: ${{ vars.STAGING_FRONTEND_ACCOUNT_ID }}') && publish.includes('AWS_EXPECTED_ACCOUNT: ${{ vars.STAGING_FRONTEND_ACCOUNT_ID }}'), 'the account comes from a repository variable and is checked twice');
  need(!ACCOUNT_ID.test(w), 'no account id in the workflow');
  need(!/GH_TOKEN/.test(w.split(/^jobs:/m)[0]) && !/^ {4}env:\n(?: {6}.+\n)*? {6}GH_TOKEN/m.test(w), 'GH_TOKEN is given to the gate steps only, not to a whole job');
  need(!w.includes('secrets.') && !w.includes('pull_request_target') && !w.includes('workflow_dispatch:'), 'no secrets, pull_request_target or manual trigger');
  return problems;
}

test('build and publish are separate: installs never run where the AWS token can be requested', () => {
  assert.deepEqual(frontendWorkflowProblems(read('../workflows/staging-frontend.yml')), []);
});

test('the workflow rules report each way the file could be weakened (controls)', () => {
  const w = read('../workflows/staging-frontend.yml');
  const weakened = [
    ['build holds id-token', w.replace('    timeout-minutes: 20\n    outputs:', '    timeout-minutes: 20\n    permissions:\n      contents: read\n      id-token: write\n    outputs:')],
    ['publish installs packages', w.replace('      - name: The downloaded bundle is the one build packed\n', '      - run: pnpm install --frozen-lockfile\n      - name: The downloaded bundle is the one build packed\n')],
    ['credentials before the digest check', w.replace('test "$(sha256sum "$RUNNER_TEMP/bundle/frontend-dist.tar" | cut -d\' \' -f1)" = "$DIST_DIGEST"', 'true')],
    ['a literal account id', w.replace('allowed-account-ids: ${{ vars.STAGING_FRONTEND_ACCOUNT_ID }}', "allowed-account-ids: '123456789012'")],
    ['publish without the main recheck', w.replace('node .github/ci/staging-release.mjs --require-current\n', '')],
    ['a build step outside the gate', w.replace("      - id: pack\n        name: Pack the bundle and record its digest\n        if: steps.gate.outputs.publish == 'true'\n", '      - id: pack\n        name: Pack the bundle and record its digest\n')],
    ['GH_TOKEN for the whole build job', w.replace('    env:\n      WEB_BUCKET: ${{ vars.STAGING_FRONTEND_WEB_BUCKET }}\n', '    env:\n      GH_TOKEN: ${{ github.token }}\n      WEB_BUCKET: ${{ vars.STAGING_FRONTEND_WEB_BUCKET }}\n')],
    ['publish not gated on build', w.replace("    if: needs.build.outputs.publish == 'true'\n", '')],
  ];
  for (const [name, broken] of weakened) {
    assert.notEqual(broken, w, `the control for "${name}" must change the real text (it does not: fix the control)`);
    assert.ok(frontendWorkflowProblems(broken).length > 0, `a weakened copy must be reported: ${name}`);
  }
});

test('publisher IAM templates pin the repository by id and this workflow file, and hold no account id', () => {
  const trustText = read('../../scripts/staging/iam/frontend-trust.json');
  const policyText = read('../../scripts/staging/iam/frontend-permissions.json');
  const doc = read('../../docs/ops/automatic-staging-frontend.md');
  for (const [name, text] of [['frontend-trust.json', trustText], ['frontend-permissions.json', policyText], ['automatic-staging-frontend.md', doc]]) assert.ok(!ACCOUNT_ID.test(text), `${name}: no account id (use <account>)`);
  const trust = JSON.parse(trustText);
  assert.equal(trust.Statement.length, 1);
  assert.equal(trust.Statement[0].Principal.Federated, 'arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com');
  assert.deepEqual(trust.Statement[0].Condition, { StringEquals: {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:Cuadrado-Zayas-Infrastrucuture/Telesphoros:environment:staging-frontend',
    'token.actions.githubusercontent.com:repository_id': '<repository_id>',
    'token.actions.githubusercontent.com:repository_owner_id': '<repository_owner_id>',
    'token.actions.githubusercontent.com:job_workflow_ref': 'Cuadrado-Zayas-Infrastrucuture/Telesphoros/.github/workflows/staging-frontend.yml@refs/heads/main',
  } });
  const policy = JSON.parse(policyText);
  assert.deepEqual(policy.Statement.map(s => s.Resource), [
    'arn:aws:s3:::<web_bucket>',
    'arn:aws:s3:::<web_bucket>/*',
    'arn:aws:cloudfront::<account>:distribution/<distribution_id>',
  ]);
  assert.deepEqual(policy.Statement.flatMap(s => s.Action).sort(), ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'].sort());
});
