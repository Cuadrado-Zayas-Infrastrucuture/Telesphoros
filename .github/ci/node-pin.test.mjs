// Run with: node --test .github/ci/node-pin.test.mjs   (pnpm test:ci-config)
// One Node version everywhere, so a new runtime is one deliberate change and every environment tests what is deployed. .nvmrc is the source of truth; CI, the image, and the engines range must agree with it, and
// .npmrc's engine-strict makes pnpm refuse to install on a Node outside that range.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Every place that pins Node, compared with .nvmrc. Returns a list of problems; empty means they agree. */
export function nodePinProblems({ nvmrc, workflows, dockerfile, packageJson, npmrc }) {
  const problems = [];
  const pinned = nvmrc.trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) return ['.nvmrc must hold one exact version, such as 22.22.0'];
  for (const [name, text] of Object.entries(workflows)) {
    const found = [...text.matchAll(/^ {2}NODE_VERSION: "([^"]*)"$/gm)].map((m) => m[1]);
    if (found.length !== 1 || found[0] !== pinned) problems.push(`${name}: NODE_VERSION must be "${pinned}" (found ${JSON.stringify(found)})`);
    const literal = [...text.matchAll(/^\s*node-version:\s*(.*?)\s*$/gm)].map((m) => m[1]).filter((v) => v !== '${{ env.NODE_VERSION }}');
    if (literal.length > 0) problems.push(`${name}: node-version must be \${{ env.NODE_VERSION }} (found ${JSON.stringify(literal)})`);
  }
  const images = [...dockerfile.matchAll(/^FROM node:([^-@\s]+)/gm)].map((m) => m[1]);
  if (images.length === 0 || images.some((v) => v !== pinned)) problems.push(`api.Dockerfile: every node image must be ${pinned} (found ${JSON.stringify(images)})`);
  const [major] = pinned.split('.');
  const engines = JSON.parse(packageJson).engines?.node;
  if (engines !== `>=${pinned} <${Number(major) + 1}`) problems.push(`package.json: engines.node must be ">=${pinned} <${Number(major) + 1}" (found ${JSON.stringify(engines)})`);
  const strict = [...(npmrc ?? '').matchAll(/^\s*engine-strict\s*=\s*(\S*)\s*$/gm)].map((m) => m[1]);
  if (strict.length !== 1 || strict[0] !== 'true') problems.push(`.npmrc: must set engine-strict=true exactly once (found ${JSON.stringify(strict)})`);
  return problems;
}

const current = () => ({
  nvmrc: read('../../.nvmrc'),
  workflows: Object.fromEntries(
    readdirSync(new URL('../workflows/', import.meta.url))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => [name, read(`../workflows/${name}`)]),
  ),
  dockerfile: read('../../infrastructure/docker/api.Dockerfile'),
  packageJson: read('../../package.json'),
  npmrc: read('../../.npmrc'),
});

test('.nvmrc, every workflow, the API image and the engines range pin the same Node, and .npmrc enforces it', () => {
  assert.deepEqual(nodePinProblems(current()), []);
});

test('the pin check reports each kind of drift', () => {
  const base = current();
  const pinned = base.nvmrc.trim();
  const other = pinned.replace(/\.(\d+)$/, (_, p) => `.${Number(p) + 1}`);
  const drift = [
    { ...base, workflows: { ...base.workflows, 'rescan.yml': base.workflows['rescan.yml'].replace(`NODE_VERSION: "${pinned}"`, `NODE_VERSION: "${other}"`) } },
    { ...base, workflows: { ...base.workflows, 'e2e-storage.yml': base.workflows['e2e-storage.yml'].replace(`NODE_VERSION: "${pinned}"`, `NODE_VERSION: "${other}"`) } },
    { ...base, workflows: { ...base.workflows, 'staging-frontend.yml': base.workflows['staging-frontend.yml'].replace(`NODE_VERSION: "${pinned}"`, `NODE_VERSION: "${other}"`) } },
    {
      ...base,
      workflows: {
        ...base.workflows,
        'staging-frontend.yml': base.workflows['staging-frontend.yml'].replace('node-version: ${{ env.NODE_VERSION }}', `node-version: '${pinned}'`),
      },
    },
    { ...base, dockerfile: base.dockerfile.replace(`node:${pinned}-`, `node:${other}-`) },
    { ...base, packageJson: base.packageJson.replace(/"node": "[^"]*"/, '"node": ">=22"') },
    { ...base, nvmrc: other },
    { ...base, npmrc: '' },
    { ...base, npmrc: base.npmrc.replace('engine-strict=true', 'engine-strict=false') },
    { ...base, npmrc: `${base.npmrc}engine-strict=false\n` },
  ];
  for (const input of drift) assert.notDeepEqual(nodePinProblems(input), [], 'drift went unreported');
});
