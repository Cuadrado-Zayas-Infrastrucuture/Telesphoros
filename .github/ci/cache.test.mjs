import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../infrastructure/docker/api.Dockerfile', import.meta.url), 'utf8');
const job = (text, name) => text.split(new RegExp(`^  ${name}:\\s*$`, 'm'))[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0] ?? '';

function cacheProblems(text, image) {
  const problems = [];
  const scan = job(text, 'secret-scan');
  if (!/cache: true\n\s+cache-dependency-path: \.github\/workflows\/ci\.yml/.test(scan)) problems.push('Go cache tracks the pinned install configuration');
  for (const name of ['Install gitleaks v8.30.1', 'Scan the full history']) {
    const step = scan.split(/^      - /m).find(s => s.startsWith('name: ' + name + '\n')) ?? '';
    if (!step || /^        (?:if|continue-on-error):/m.test(step)) problems.push('scan and install must run on a cache hit');
  }
  const browser = job(text, 'browser');
  if (!browser.includes('key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-version.outputs.version }}')) problems.push('browser cache follows installed Playwright and architecture');
  const build = job(text, 'image');
  if (!build.includes('cache-from: type=gha,scope=api-amd64-v1,timeout=2m') || !build.includes('cache-to: type=gha,scope=api-amd64-v1,mode=max,ignore-error=true,timeout=2m')) problems.push('bounded scoped image cache');
  const positions = ['COPY pnpm-lock.yaml pnpm-workspace.yaml ./', 'RUN pnpm fetch --frozen-lockfile', 'COPY . .', 'RUN pnpm install --frozen-lockfile --offline'].map(s => image.indexOf(s));
  if (positions.some(n => n < 0) || positions.some((n, i) => i > 0 && n <= positions[i - 1])) problems.push('source changes must not invalidate dependency fetch');
  return problems;
}

test('dependency caches preserve fresh installation/scanning and isolate Docker dependency inputs', () => {
  assert.deepEqual(cacheProblems(workflow, dockerfile), []);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
});

test('cache controls reject stale browser keys, optional scanning and invalid layer order', () => {
  for (const [text, image] of [
    [workflow.replace('cache: true', 'cache: false'), dockerfile],
    [workflow.replace('steps.playwright-version.outputs.version', "hashFiles('pnpm-lock.yaml')"), dockerfile],
    [workflow.replace('- name: Scan the full history\n', '- name: Scan the full history\n        if: false\n'), dockerfile],
    [workflow.replace('- name: Install gitleaks v8.30.1\n', '- name: Install gitleaks v8.30.1\n        if: false\n'), dockerfile],
    [workflow.replace('timeout=2m', 'timeout=20m'), dockerfile],
    [workflow, dockerfile.replace('COPY . .\n', '').replace('RUN pnpm fetch --frozen-lockfile', 'COPY . .\nRUN pnpm fetch --frozen-lockfile')],
  ]) assert.ok(cacheProblems(text, image).length > 0);
});

test('the actual browser cache version command tracks package updates and refuses malformed metadata', () => {
  const browser = job(workflow, 'browser');
  const script = browser.match(/node <<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1].replace(/^          /gm, '');
  assert.ok(script, 'execute the actual workflow command');
  const dir = mkdtempSync(join(tmpdir(), 'ci-browser-cache-'));
  try {
    const moduleDir = join(dir, 'node_modules/@playwright/test');
    mkdirSync(moduleDir, { recursive: true });
    for (const [i, version] of ['1.64.0', '1.65.0', '', '1.64', '1.64.0\nother=value'].entries()) {
      writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ version }));
      const output = join(dir, `output-${i}`);
      const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      if (i < 2) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `version=${version}\n`);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(output), false, 'invalid metadata must not create a reusable cache key');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
