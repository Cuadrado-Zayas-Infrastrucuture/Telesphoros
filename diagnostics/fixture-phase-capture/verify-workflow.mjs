import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const workflow = new URL('../../.github/workflows/fixture-phase-capture.yml', import.meta.url);
const deadline = readFileSync(new URL('../../.github/ci/service-deadline.mjs', import.meta.url), 'utf8');

export function problems(text) {
  const errors = [];
  const trigger = text.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1].trimEnd();
  if (trigger !== '  push:\n    branches: [chore/native-x64-fixture-capture-20261018]') errors.push('exact isolated push trigger');
  const body = text.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map(match => match[1]);
  if (JSON.stringify(jobs) !== '["fixture-phase-capture"]' || /\bstrategy:|\bmatrix:|\bneeds:/.test(body)) errors.push('one job only');
  for (const line of ["    if: github.event.created == true && github.run_attempt == '1'", '    runs-on: ubuntu-24.04', '    timeout-minutes: 30']) {
    if (!text.split('\n').includes(line)) errors.push('first-push native runner and unchanged deadline');
  }
  if (/continue-on-error|:\s*write\b|secrets\.|id-token:|^ {4}environment:/m.test(text)) errors.push('no failure masking, deployment or write credentials');
  if (!/^permissions:\n {2}contents: read\n/m.test(text) || !/^ {6}actions: read$/m.test(text)) errors.push('read-only repository/run metadata');
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
    if (!/@[a-f0-9]{40}$/.test(match[1]) || !/# v\d/.test(match[2])) errors.push('pinned actions');
  }
  const embedded = text.match(/<<'SERVICE_DEADLINE'\n([\s\S]*?)^ {10}SERVICE_DEADLINE$/m)?.[1].split('\n').map(line => line.slice(10)).join('\n');
  if (embedded !== deadline) errors.push('unchanged original watchdog bootstrap');
  if (text.indexOf('bootstrap\n') > text.indexOf('uses: actions/checkout@')) errors.push('watchdog before checkout');
  if (!/^ {8}run: node diagnostics\/fixture-phase-capture\/capture\.mjs run$/m.test(text)) errors.push('one unmasked capture command');
  if ((text.match(/uses: actions\/upload-artifact@/g) ?? []).length !== 1 || !/^ {10}retention-days: 1$/m.test(text)
    || !/^ {8}if: always\(\) && steps\.evidence\.outputs\.bounded == 'true'$/m.test(text)
    || !/^ {10}path: \$\{\{ runner\.temp \}\}\/fixture-phase-capture$/m.test(text)) errors.push('one bounded failure-preserving artifact');
  if (!text.includes('fetch-depth: 2') || !text.includes('SERVICE_WATCHDOG_REQUIRED: "1"')) errors.push('source baseline and hosted watchdog required');
  for (const setting of ['AWS_CONFIG_FILE: /dev/null', 'AWS_SHARED_CREDENTIALS_FILE: /dev/null', 'AWS_EC2_METADATA_DISABLED: "true"',
    'TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/postgres', 'TEST_S3_ENDPOINT: http://127.0.0.1:5555']) {
    if (!text.includes(setting)) errors.push('synthetic local service boundaries');
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = problems(readFileSync(workflow, 'utf8'));
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else console.log('Capture scope, original watchdog, trigger and artifact controls passed.');
}
