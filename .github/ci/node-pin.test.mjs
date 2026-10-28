// Run with: node --test .github/ci/node-pin.test.mjs   (pnpm test:ci-config)
// One Node version everywhere. The lab-report matcher refuses a runtime whose Unicode version differs from the one it was
// built for (apps/backend/src/services/report-adapter/unavailable-matcher.ts), so a developer on another major sees dozens
// of suites fail at import. .nvmrc is the source of truth; CI, the image, and the engines range must agree with it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Every place that pins Node, compared with .nvmrc. Returns a list of problems; empty means they agree. */
export function nodePinProblems({ nvmrc, workflows, dockerfile, packageJson }) {
  const problems = [];
  const pinned = nvmrc.trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) return ['.nvmrc must hold one exact version, such as 22.22.0'];
  for (const [name, text] of Object.entries(workflows)) {
    const found = [...text.matchAll(/^ {2}NODE_VERSION: "([^"]*)"$/gm)].map((m) => m[1]);
    if (found.length !== 1 || found[0] !== pinned) problems.push(`${name}: NODE_VERSION must be "${pinned}" (found ${JSON.stringify(found)})`);
  }
  const images = [...dockerfile.matchAll(/^FROM node:([^-@\s]+)/gm)].map((m) => m[1]);
  if (images.length === 0 || images.some((v) => v !== pinned)) problems.push(`api.Dockerfile: every node image must be ${pinned} (found ${JSON.stringify(images)})`);
  const [major] = pinned.split('.');
  const engines = JSON.parse(packageJson).engines?.node;
  if (engines !== `>=${pinned} <${Number(major) + 1}`) problems.push(`package.json: engines.node must be ">=${pinned} <${Number(major) + 1}" (found ${JSON.stringify(engines)})`);
  return problems;
}

const current = () => ({
  nvmrc: read('../../.nvmrc'),
  workflows: { 'ci.yml': read('../workflows/ci.yml'), 'rescan.yml': read('../workflows/rescan.yml') },
  dockerfile: read('../../infrastructure/docker/api.Dockerfile'),
  packageJson: read('../../package.json'),
});

test('.nvmrc, both workflows, the API image and the engines range pin the same Node', () => {
  assert.deepEqual(nodePinProblems(current()), []);
});

test('the pin check reports each kind of drift', () => {
  const base = current();
  const pinned = base.nvmrc.trim();
  const other = pinned.replace(/\.(\d+)$/, (_, p) => `.${Number(p) + 1}`);
  const drift = [
    { ...base, workflows: { ...base.workflows, 'rescan.yml': base.workflows['rescan.yml'].replace(`NODE_VERSION: "${pinned}"`, `NODE_VERSION: "${other}"`) } },
    { ...base, dockerfile: base.dockerfile.replace(`node:${pinned}-`, `node:${other}-`) },
    { ...base, packageJson: base.packageJson.replace(/"node": "[^"]*"/, '"node": ">=22"') },
    { ...base, nvmrc: other },
  ];
  for (const input of drift) assert.notDeepEqual(nodePinProblems(input), [], 'drift went unreported');
});
