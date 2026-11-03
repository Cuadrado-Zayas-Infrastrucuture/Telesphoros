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
test('deployment credentials and upload stay behind the main gate and serialized environment', () => {
  const w = read('../workflows/staging-frontend.yml');
  for (const text of ['workflows: [ci]', 'branches: [main]', "github.event.workflow_run.event == 'push'", 'github.event.workflow_run.head_repository.full_name == github.repository', "vars.STAGING_FRONTEND_AUTO_DEPLOY == 'true'", 'environment: staging-frontend', 'cancel-in-progress: false', 'ref: ${{ github.event.workflow_run.head_sha }}', 'node .github/ci/staging-release.mjs --require-current', "allowed-account-ids: '403776649274'", 'aws cloudfront wait invalidation-completed', 'r.commit!==process.env.RELEASE_SHA']) assert.ok(w.includes(text), text);
  assert.ok(w.indexOf('pnpm install --frozen-lockfile') < w.indexOf('uses: aws-actions/configure-aws-credentials@'));
  assert.ok(w.indexOf('--require-current') < w.indexOf('publish-frontend.sh --yes'));
  assert.equal((w.match(/if: steps.gate.outputs.publish == 'true'/g) ?? []).length, 4);
  assert.ok(!w.includes('secrets.') && !w.includes('pull_request_target') && !w.includes('workflow_dispatch:'));
});
test('publisher IAM is restricted to the observed web bucket and distribution', () => {
  const trust = JSON.parse(read('../../scripts/staging/iam/frontend-trust.json'));
  assert.deepEqual(trust.Statement[0].Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:Cuadrado-Zayas-Infrastrucuture/Telesphoros:environment:staging-frontend',
  });
  const policy = JSON.parse(read('../../scripts/staging/iam/frontend-permissions.json'));
  assert.deepEqual(policy.Statement.map(s => s.Resource), [
    'arn:aws:s3:::telesphoros-staging-web-85b1e5378b2a7a0be7cfafa366',
    'arn:aws:s3:::telesphoros-staging-web-85b1e5378b2a7a0be7cfafa366/*',
    'arn:aws:cloudfront::403776649274:distribution/E1WD7E7PP8PU73',
  ]);
  assert.deepEqual(policy.Statement.flatMap(s => s.Action).sort(), ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'].sort());
});
