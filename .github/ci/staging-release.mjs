import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function eligible(run, repository, mainSha) {
  return Boolean(run && /^[a-f0-9]{40}$/.test(mainSha) && run.head_sha === mainSha && run.conclusion === 'success' && run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/ci.yml' && run.repository?.full_name === repository && run.head_repository?.full_name === repository);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
  const main = JSON.parse(execFileSync('gh', ['api', `repos/${GITHUB_REPOSITORY}/git/ref/heads/main`], { encoding: 'utf8' })).object.sha;
  const ok = eligible(event.workflow_run, GITHUB_REPOSITORY, main);
  if (process.argv.includes('--require-current') && !ok) throw new Error('Refusing to publish: CI is not successful for current main');
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `publish=${ok}\n`);
  console.log(ok ? `Eligible main commit: ${main}` : 'Skipping stale or ineligible CI run');
}
