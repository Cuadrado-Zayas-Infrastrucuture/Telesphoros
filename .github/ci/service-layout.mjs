import { readFileSync } from 'node:fs';
const supervisorSource = readFileSync(new URL('./service-deadline.mjs', import.meta.url), 'utf8');
// Structural tripwire; native execution and evidence controls live in service-isolation.test.mjs.
export const internalJobs = ['service-memory', 'service-postgres', 'service-postgres-s3'];
// The one condition by which a job may be skipped. `!cancelled()` is the status function that stops GitHub adding an implicit success(), which would skip
// the job whenever `changes` fails; the failure arm makes a broken `changes` run everything. Event, branch and draft logic stays inside scope.mjs, so no required job's `if`
// reads the event or the branch (a merge-queue batch has neither a pull request nor a branch of its own).
export const heavyCondition = "${{ !cancelled() && (needs.changes.outputs.heavy == 'true' || needs.changes.result == 'failure') }}";
export const guardsCondition = "${{ !cancelled() && (needs.changes.outputs.guards == 'true' || needs.changes.result == 'failure') }}";
export const terraformCondition = "${{ !cancelled() && (needs.changes.outputs.terraform == 'true' || needs.changes.result == 'failure') }}";
/** The condition of a step inside a job that always runs (verify): the heavy half of its work. No status function, so GitHub keeps its implicit success(). */
export const heavyStepCondition = "${{ needs.changes.outputs.heavy == 'true' || needs.changes.result == 'failure' }}";
export const archiveCondition = "${{ !cancelled() && (needs.changes.outputs.archive == 'true' || needs.changes.result == 'failure') }}";
// The joining gate is skipped only when ALL three producers were skipped; one skipped beside a producer that ran still reaches its dependency check.
export const gateCondition = "always() && !(needs.service-memory.result == 'skipped' && needs.service-postgres.result == 'skipped' && needs.service-postgres-s3.result == 'skipped')";
/** A job with its scope condition and `needs: changes` removed, so the rest of its shape can be checked as before. */
export const withoutScopeGate = job => [heavyCondition, guardsCondition, terraformCondition, archiveCondition].reduce((text, c) => text.replace(`    if: ${c}\n`, ''), job).replace('    needs: changes\n', '');
export function jobOf(text, key) {
  return text.split(/^jobs:\s*$/m)[1]?.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).find(b => b.startsWith(key + ':')) ?? '';
}
function resolvedJob(text, key) {
  const block = jobOf(text, key);
  const anchor = text.match(/^      - &service_deadline\n([\s\S]*?)(?=^      - |$(?![\s\S]))/m)?.[1];
  return anchor ? block.replace('      - *service_deadline\n', '      - ' + anchor.replace(/^ {8}/, '')) : block;
}
export function serviceLayoutProblems(text) {
  const problems = [];
  const require = (ok, label) => { if (!ok) problems.push(label); };
  const embedded = text.match(/<<'SERVICE_DEADLINE'\n([\s\S]*?)^          SERVICE_DEADLINE$/m)?.[1]?.replace(/^ {10}/gm, '');
  require(embedded === supervisorSource, 'bootstrap exactly matches the canonical supervisor');
  require((text.match(/- &service_deadline$/gm) ?? []).length === 1 && (text.match(/- \*service_deadline$/gm) ?? []).length === 3, 'every service job arms the same first-step supervisor');
  require(!text.includes('fromJSON(steps.budget.outputs.minutes)'), 'no stale relative action timeout');
  const gate = resolvedJob(text, 'database-and-storage');
  require((gate.match(/^    if:.*$/gm) ?? []).join('\n') === `    if: ${gateCondition}`, 'joining gate runs unless every producer was skipped');
  require(/^    needs: \[service-memory, service-postgres, service-postgres-s3\]$/m.test(gate), 'joining gate needs all three producers');
  for (const key of [...internalJobs, 'database-and-storage']) {
    const job = resolvedJob(text, key);
    require(/^    timeout-minutes: 30$/m.test(job), key + ' keeps the timeout');
    require(/^    permissions:\n      contents: read\n      actions: read$/m.test(job), key + ' has only clock API read permission');
    require(/^    runs-on: ubuntu-24.04$/m.test(job) && /image: postgres:16/.test(job)
      && /TEST_DATABASE_URL: postgres:\/\/postgres:postgres@127.0.0.1:5432\/postgres/.test(job)
      && /TEST_S3_ENDPOINT: http:\/\/127.0.0.1:5555/.test(job) && /moto_server -H 127.0.0.1 -p 5555/.test(job), key + ' owns its services');
    require(job.includes('      SERVICE_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'), key + ' binds the API head');
    require(!/continue-on-error:/.test(job) && !/TELESPHOROS_WORKSPACE_PREPARED/.test(job), key + ' cannot swallow failures or inherit preparation');
    require(job.includes('      SERVICE_WATCHDOG_REQUIRED: \"1\"'), key + ' requires a live supervisor');
    require(/    steps:\n      - (?:&service_deadline\n        name:|name:) Arm the shared deadline before action setup\n/.test(job), key + ' arms before checkout');
    require(job.indexOf('node \"$RUNNER_TEMP/service-deadline.mjs\" bootstrap') < job.indexOf('uses: actions/checkout@'), key + ' bootstrap precedes all actions');
    const boot = job.split(/^      - /m).slice(1)[0] ?? '';
    const harness = `          umask 077
          test -d "$RUNNER_TEMP" && test ! -L "$RUNNER_TEMP"
          (set -o noclobber; cat > "$RUNNER_TEMP/service-deadline.mjs") <<'SERVICE_DEADLINE'
` + supervisorSource.split('\n').slice(0, -1).map(l => l ? '          ' + l + '\n' : '\n').join('') + `          SERVICE_DEADLINE
          node "$RUNNER_TEMP/service-deadline.mjs" bootstrap
`;
    require(boot.match(/^        run: \|\n([\s\S]*)$/m)?.[1] === harness, key + ' cannot bypass the canonical bootstrap harness');

    require(boot.includes('id: deadline\n') && boot.includes('timeout-minutes: 1\n') && !/^        (?:if|continue-on-error):/m.test(boot), key + ' mandatory bounded bootstrap');
    require(boot.trimEnd().endsWith('node "$RUNNER_TEMP/service-deadline.mjs" bootstrap'), key + ' cannot skip bootstrap execution');
    for (const step of job.split(/^      - /m).slice(1).filter(s => s.includes('uses: actions/upload-artifact@'))) {
      require(step.includes("steps.deadline.outputs.armed == 'true'"), key + ' cannot transfer after failed bootstrap');
    }
    const steps = job.split(/^      - /m).slice(1);
    for (const command of ['node .github/ci/service-budget.mjs init', 'node .github/ci/service-budget.mjs check',
      ...(key === 'database-and-storage' ? ['node .github/ci/service-evidence.mjs dependencies', 'node .github/ci/service-evidence.mjs collect',
        'node .github/ci/service-evidence.mjs finish', 'node .github/ci/verify-recovery-metrics.mjs', 'node .github/ci/verify-application-recovery.mjs'] : [])]) {
      const matches = steps.filter(s => s.includes('run: ' + command));
      require(matches.length === 1 && !/^        (?:if|continue-on-error):/m.test(matches[0] ?? '')
        && matches[0]?.includes('run: ' + command + '\n'), key + ' mandatory ' + command);
    }
    require(job.lastIndexOf('service-budget.mjs check') > job.lastIndexOf('uses:'), key + ' checks the clock after transfers');
    require(job.indexOf('service-budget.mjs init') < job.indexOf('pnpm install --frozen-lockfile'), key + ' starts clock before install');
    if (internalJobs.includes(key)) {
      require((job.match(/^    if:.*$/gm) ?? []).join('\n') === `    if: ${heavyCondition}` && (job.match(/^    needs:.*$/gm) ?? []).join('\n') === '    needs: changes', key + ' independent producer skipped only by the scope condition');
      const profile = key.slice('service-'.length);
      const command = { memory: 'pnpm --filter @telesphoros/backend test', postgres: 'TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test',
        'postgres-s3': 'TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test' }[profile];
      const log = { memory: 'tier1.log', postgres: 'tier2.log', 'postgres-s3': 'tier3.log' }[profile];
      const script = `node .github/ci/service-evidence.mjs run ${profile} <<'PROFILE'\n          set -o pipefail\n          ${command} 2>&1 | tee ${log}\n          ! grep -F "[jest] NOT RUNNING" ${log}\n          PROFILE\n`;
      const matches = steps.filter(s => s.includes(script));
      require(matches.length === 1 && !/^        if:/m.test(matches[0] ?? ''), key + ' runs the exact whole profile');
      require(job.includes(`name: service-profile-${profile}-` + '${{ github.run_attempt }}') && job.includes(`path: ` + '${{ runner.temp }}' + `/service-profile-${profile}\n`), key + ' retains attempt-specific completion');
    }
  }
  require(gate.includes('      SERVICE_NEEDS: ${{ toJSON(needs) }}'), 'joining gate reads actual dependency results');
  const download = gate.split(/^      - /m).find(s => s.includes('uses: actions/download-artifact@')) ?? '';
  require(download.includes('pattern: service-profile-*-${{ github.run_attempt }}') && download.includes('merge-multiple: false')
    && download.includes('digest-mismatch: error') && download.includes('path: ${{ runner.temp }}/service-profiles')
    && !/(?:run-id|repository|github-token|artifact-ids|\n          name):/.test(download), 'download only current run and attempt, without merging');
  const positions = ['service-evidence.mjs dependencies', 'service-budget.mjs init', 'uses: actions/download-artifact@',
    'service-evidence.mjs collect', 'service-evidence.mjs run worker', 'verify-recovery-metrics.mjs',
    'verify-application-recovery.mjs', 'service-evidence.mjs finish', 'service-budget.mjs check'].map(s => gate.indexOf(s));
  require(positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1])), 'joining gate proof ordering');
  require(gate.includes(`node .github/ci/service-evidence.mjs run worker <<'PROFILE'\n          set -o pipefail\n          pnpm --filter @telesphoros/worker test 2>&1 | tee tier-worker.log\n          ! grep -F "NOT RUNNING" tier-worker.log\n          PROFILE\n`), 'unchanged whole worker profile');
  return problems;
}
