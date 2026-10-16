import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkill, rank, checkLinks, evaluate } from './check-workflows.mjs';

const skills = [
  { name: 'debug', description: 'Reproduce crashes and isolate failure root causes.' },
  { name: 'release', description: 'Assess launch readiness and deployment prerequisites.' },
];

test('routing distinguishes root-cause work from release readiness, with a nonzero match', () => {
  assert.equal(rank('Reproduce this crash and find its root cause', skills)[0].name, 'debug');
  assert.equal(rank('Assess deployment launch readiness', skills)[0].name, 'release');
  assert.equal(rank('unrelated', skills)[0].score, 0);
});

test('positive cases and negative competitors expose an over-broad or swapped description', () => {
  const cases = [
    { name: 'debug', positive: ['reproduce crash', 'failure root cause', 'isolate failure'], negative: [{ prompt: 'launch readiness', owner: 'release' }, { prompt: 'deployment prerequisites', owner: 'release' }] },
    { name: 'release', positive: ['launch readiness', 'deployment prerequisites', 'assess launch'], negative: [{ prompt: 'reproduce crash', owner: 'debug' }, { prompt: 'failure root cause', owner: 'debug' }] },
  ];
  assert.equal(evaluate(skills, cases).passed, 10);
  const broken = skills.map((s, i) => ({ ...s, description: skills[1 - i].description }));
  assert.ok(evaluate(broken, cases).passed < 10);
  assert.throws(() => evaluate(skills, cases.slice(0, 1)), /coverage/);
  assert.throws(() => evaluate(skills, [{ ...cases[0], negative: [{ prompt: 'x', owner: 'missing' }, cases[0].negative[1]] }, cases[1]]), /Unknown/);
});

test('link checks catch broken files, traversal and symlink escape while accepting real references', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'telesphoros-workflow-links-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'real.md'), '# Heading\n');
  writeFileSync(join(scratch, 'outside.md'), 'outside');
  symlinkSync(join(scratch, 'outside.md'), join(root, 'escape.md'));
  const file = join(root, 'SKILL.md');
  assert.deepEqual(checkLinks('[real](real.md#heading) [docs](https://example.com) [local](#heading)', file, root), []);
  for (const target of ['missing.md', '../outside.md', 'escape.md']) assert.equal(checkLinks(`[bad](${target})`, file, root).length, 1);
});

test('metadata accepts the supported frontmatter and refuses missing or unfinished values', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'telesphoros-workflow-metadata-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const file = join(scratch, 'SKILL.md');
  writeFileSync(file, '---\nname: valid-skill\ndescription: A usable description.\n---\nBody.');
  assert.equal(readSkill(file).name, 'valid-skill');
  for (const value of ['no header', '---\nname: Invalid_Name\ndescription: x\n---\n', '---\nname: okay\n---\n', '---\nname: okay\ndescription: [TODO: fill]\n---\n']) {
    writeFileSync(file, value);
    assert.throws(() => readSkill(file));
  }
});
