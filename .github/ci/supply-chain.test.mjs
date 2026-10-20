// Run with: pnpm test:ci-config
// Supply-chain rules for EVERY workflow file, not only ci.yml (audit findings INF-11 and INF-17, 2026-10-19). Like guard.test.mjs it reads text and cannot prove
// what GitHub or a registry will do; it stops the quiet ways a build input becomes movable:
//   - a workflow nobody reviewed for this list (a diagnostic one was merged once, despite its own "never merge" header),
//   - a container image or Go toolchain named by a tag that can be re-pointed,
//   - a Python package installed without a hash, or a scanner whose version moves with its wrapper,
//   - the scheduled rescan quietly becoming a merge gate, or quietly stopping.
// `supplyChainProblems` returns what is wrong with copies of the files (empty when nothing is); the controls run it on deliberately broken copies.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('../workflows/', import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const real = {
  workflows: Object.fromEntries(readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => [name, readFileSync(new URL(name, dir), 'utf8')])),
  requirementsIn: read('./requirements.in'),
  requirementsTxt: read('./requirements.txt'),
  dependabot: read('../dependabot.yml'),
};

/** The only workflow files allowed on main. Adding one means changing this line, in review. */
export const WORKFLOWS = ['ci.yml', 'rescan.yml'];

const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

export function supplyChainProblems({ workflows, requirementsIn, requirementsTxt, dependabot }) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };

  // INF-17: exactly the reviewed workflows.
  need(JSON.stringify(Object.keys(workflows).sort()) === JSON.stringify([...WORKFLOWS].sort()), `the workflows must be exactly ${WORKFLOWS.join(', ')} (found ${Object.keys(workflows).join(', ')})`);

  for (const [name, raw] of Object.entries(workflows)) {
    const text = code(raw);
    // The ci.yml rules of guard.test.mjs, for every workflow.
    for (const [, ref, rest] of text.matchAll(/^[ \t]*-?[ \t]*uses:[ \t]*(\S+)(.*)$/gm)) {
      need(/@[0-9a-f]{40}$/.test(ref) && /#\s*v\d/.test(rest), `${name}: ${ref} must be pinned to a commit SHA with a "# vX.Y.Z" comment`);
    }
    need(/^permissions:\n {2}contents: read\n/m.test(raw) && !/:\s*write\b/.test(text), `${name}: permissions must be read-only`);
    need(!/pull_request_target/.test(text) && !/secrets\./.test(text), `${name}: no pull_request_target and no repository secrets`);
    // Container images by digest only: a tag can be re-pointed under a green check.
    for (const [, image] of text.matchAll(/^[ \t]*image:[ \t]*(\S+)/gm)) need(/@sha256:[0-9a-f]{64}$/.test(image), `${name}: image ${image} must be pinned by digest`);
    // Python packages only with hashes, and only from the hashed file.
    for (const [line] of text.matchAll(/^.*\bpip install\b.*$/gm)) {
      need(/pip install --require-hashes -r \.github\/ci\/requirements\.txt\s*$/.test(line), `${name}: "${line.trim()}" must be exactly "pip install --require-hashes -r .github/ci/requirements.txt"`);
    }
    // Toolchains and scanners at exact versions.
    for (const [, version] of text.matchAll(/^[ \t]*go-version:[ \t]*(\S+)/gm)) need(/^'?\d+\.\d+\.\d+'?$/.test(version), `${name}: go-version ${version} must be an exact release`);
    for (const block of text.split(/\n(?=\s*- )/).filter((b) => /uses:\s*aquasecurity\/trivy-action@/.test(b))) {
      need(/^\s*version:[ \t]*v\d+\.\d+\.\d+[ \t]*(#.*)?$/m.test(block), `${name}: trivy-action must pin the Trivy binary with "version: vX.Y.Z"`);
    }
  }

  // All PostgreSQL service images are the same digest, so the tiers test one server.
  const postgres = new Set(Object.values(workflows).flatMap((t) => [...code(t).matchAll(/^[ \t]*image:[ \t]*(postgres:\S+)/gm)].map((m) => m[1])));
  need(postgres.size === 1, `every PostgreSQL service must use one pinned image (found ${[...postgres].join(', ') || 'none'})`);

  // The hashed requirements: generated from requirements.in, every package pinned and hashed.
  need(/^moto\[server\]==\d+\.\d+\.\d+$/m.test(requirementsIn), 'requirements.in must pin the S3 emulator exactly');
  need(/uv pip compile requirements\.in --generate-hashes/.test(requirementsTxt), 'requirements.txt must be generated from requirements.in with hashes');
  const packages = requirementsTxt.split(/\n(?=[a-z0-9])/i).filter((b) => /^[a-z0-9]/i.test(b));
  need(packages.length >= 10, `requirements.txt must list the whole dependency tree (found ${packages.length} packages)`);
  for (const p of packages) need(/^[a-z0-9._[\]-]+==[^\s\\]+ \\\n\s+--hash=sha256:[0-9a-f]{64}/i.test(p), `requirements.txt: ${p.split('\n')[0]} must be pinned with == and hashed`);
  need(packages.some((p) => /^moto==/.test(p)), 'requirements.txt must contain moto');

  // Dependabot keeps the image base layers current (the workflow service images are not covered by any ecosystem: see rescan.yml).
  need(/package-ecosystem: docker\n\s+directory: \/infrastructure\/docker\n/.test(dependabot), 'Dependabot must watch the Dockerfiles in infrastructure/docker');

  // The weekly rescan: advisory (never a merge gate), on a schedule, and it fails loudly.
  const rescan = code(workflows['rescan.yml'] ?? '');
  need(/^on:\n {2}schedule:\n {4}- cron: '[^']+'[^\n]*\n {2}workflow_dispatch:\n(?! )/m.test(rescan), 'rescan.yml must run only on its schedule and by hand (never on push or pull_request, so it cannot gate a merge)');
  need(/trivy(-action)?/.test(rescan) && /exit-code: '1'/.test(rescan) && /severity: CRITICAL,HIGH/.test(rescan), 'rescan.yml must fail on a CRITICAL or HIGH finding in a fresh image');
  need(/pnpm audit --prod --audit-level high/.test(rescan), 'rescan.yml must audit the production dependencies');
  need(/timeout-minutes: \d+/.test(rescan), 'rescan.yml must have a time limit');
  return problems;
}

test('every workflow meets the supply-chain rules (and the scan found the files: a floor, so an empty read cannot pass)', () => {
  assert.ok(Object.keys(real.workflows).length >= 1 && real.requirementsTxt.length > 1000);
  assert.deepEqual(supplyChainProblems(real), []);
});

test('the supply-chain rules report each way the files could be weakened (controls)', () => {
  const ci = real.workflows['ci.yml'];
  const rescan = real.workflows['rescan.yml'] ?? '';
  const pg = /image: (postgres:16@sha256:[0-9a-f]{64})/.exec(ci)?.[1] ?? 'postgres:16@sha256:missing';
  const weakened = [
    ['an unreviewed workflow', { workflows: { ...real.workflows, 'debug.yml': 'name: x\npermissions:\n  contents: read\n' } }],
    ['the diagnostic workflow restored', { workflows: { ...real.workflows, 'fixture-phase-capture.yml': 'name: x\npermissions:\n  contents: read\n' } }],
    ['a service image by tag', { workflows: { ...real.workflows, 'ci.yml': ci.replace(`image: ${pg}`, 'image: postgres:16') } }],
    ['two different PostgreSQL digests', { workflows: { ...real.workflows, 'ci.yml': ci.replace(`image: ${pg}`, `image: postgres:16@sha256:${'0'.repeat(64)}`) } }],
    ['pip without hashes', { workflows: { ...real.workflows, 'ci.yml': ci.replace('pip install --require-hashes -r .github/ci/requirements.txt', 'pip install -r .github/ci/requirements.txt') } }],
    ['pip installs a loose package', { workflows: { ...real.workflows, 'ci.yml': ci.replace('pip install --require-hashes -r .github/ci/requirements.txt', 'pip install --require-hashes -r .github/ci/requirements.txt moto') } }],
    ['Go follows "stable"', { workflows: { ...real.workflows, 'ci.yml': ci.replace(/go-version: '\d+\.\d+\.\d+'/, 'go-version: stable') } }],
    ['Trivy follows the action default', { workflows: { ...real.workflows, 'ci.yml': ci.replace(/\n\s+version: v\d+\.\d+\.\d+[^\n]*(?=\n)/, '') } }],
    ['the rescan runs on pull requests (a merge gate)', { workflows: { ...real.workflows, 'rescan.yml': rescan.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n') } }],
    ['the rescan no longer audits packages', { workflows: { ...real.workflows, 'rescan.yml': rescan.replace('pnpm audit --prod --audit-level high', 'pnpm audit --prod --audit-level critical') } }],
    ['the rescan never fails', { workflows: { ...real.workflows, 'rescan.yml': rescan.replace("exit-code: '1'", "exit-code: '0'") } }],
    ['the rescan action by tag', { workflows: { ...real.workflows, 'rescan.yml': rescan.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7') } }],
    ['the rescan may write', { workflows: { ...real.workflows, 'rescan.yml': rescan.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  issues: write\n') } }],
    ['a package without a hash', { requirementsTxt: real.requirementsTxt.replace(/(\nmoto==[^\n]+) \\\n(\s+--hash=sha256:[0-9a-f]{64} \\\n)+/, '$1\n') }],
    ['a package by range', { requirementsTxt: real.requirementsTxt.replace(/\nmoto==/, '\nmoto>=') }],
    ['a hand-edited requirements file', { requirementsTxt: real.requirementsTxt.replace('uv pip compile requirements.in --generate-hashes', 'pip freeze') }],
    ['the emulator by range', { requirementsIn: real.requirementsIn.replace(/moto\[server\]==/, 'moto[server]>=') }],
    ['Dependabot stops watching the Dockerfiles', { dependabot: real.dependabot.replace(/  - package-ecosystem: docker\n/, '  - package-ecosystem: dockerx\n') }],
  ];
  for (const [name, change] of weakened) {
    const copy = { ...real, ...change };
    assert.ok(Object.keys(change).every((k) => JSON.stringify(copy[k]) !== JSON.stringify(real[k])), `the control for "${name}" must change the real text (it does not: fix the control)`);
    assert.ok(supplyChainProblems(copy).length > 0, `a weakened copy must be reported: ${name}`);
  }
});
