// Run with: node --test .github/ci/status-fragments.test.mjs   (pnpm test:ci-config)
// docs/status/ holds one fragment per pull request instead of one shared file everyone edits.
// This guard keeps the folder machine-readable: every file is YYYY-MM-DD-slug.md, starts with a
// "# Title" heading and a "Date:" line that matches the file name, and no slug is used twice.
// Each rule has a control below that breaks it on purpose and must be reported.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FRAGMENT_DIR, fragmentProblems, isCalendarDate, readFragments, renderIndex } from '../../scripts/status-index.mjs';

const script = new URL('../../scripts/status-index.mjs', import.meta.url).pathname;

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  for (const [name, body] of Object.entries(files)) {
    if (body === null) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), body);
  }
  return dir;
}
function problemsFor(files) {
  const dir = folder(files);
  try {
    return fragmentProblems(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const good = (date, title = 'A change') => `# ${title}\n\nDate: ${date}\n\nWhat changed.\n`;

test('every fragment in docs/status/ is well formed, and there is at least one', () => {
  const fragments = readFragments();
  assert.ok(fragments.length >= 1, 'a scan that finds no fragment proves nothing; this change adds the first one');
  assert.deepEqual(fragmentProblems(), []);
});

test('the guard accepts well-formed fragments (positive control)', () => {
  assert.deepEqual(problemsFor({ '2026-10-20-first.md': good('2026-10-20'), '2026-10-21-second.md': good('2026-10-21') }), []);
});

test('a missing heading is reported', () => {
  const found = problemsFor({ '2026-10-20-first.md': 'Date: 2026-10-20\n\nNo heading.\n' });
  assert.ok(found.some((p) => p.includes('not a "# Title" heading')), found.join('\n'));
  assert.ok(problemsFor({ '2026-10-20-first.md': '#NoSpace\n\nDate: 2026-10-20\n' }).length > 0, 'a heading needs a space and a title');
  assert.ok(problemsFor({ '2026-10-20-first.md': '\n# Late heading\n\nDate: 2026-10-20\n' }).length > 0, 'the heading must be line 1');
});

test('a missing, malformed or impossible date is reported', () => {
  assert.ok(problemsFor({ '2026-10-20-first.md': '# T\n\nNo date here.\n' }).some((p) => p.includes('"Date: YYYY-MM-DD"')));
  assert.ok(problemsFor({ '2026-10-20-first.md': '# T\n\nDate: 20-10-2026\n' }).some((p) => p.includes('"Date: YYYY-MM-DD"')));
  assert.ok(problemsFor({ '2026-02-30-first.md': good('2026-02-30') }).some((p) => p.includes('not a real calendar date')));
  assert.ok(problemsFor({ '2026-13-01-first.md': good('2026-13-01') }).some((p) => p.includes('not a real calendar date')));
});

test('a Date line that does not match the file name is reported', () => {
  const found = problemsFor({ '2026-10-20-first.md': good('2026-10-21') });
  assert.ok(found.some((p) => p.includes('does not match the file name date')), found.join('\n'));
});

test('a repeated slug is reported, even on different dates', () => {
  const found = problemsFor({ '2026-10-20-same.md': good('2026-10-20'), '2026-10-22-same.md': good('2026-10-22') });
  assert.ok(found.some((p) => p.includes('slug "same" is used by 2026-10-20-same.md, 2026-10-22-same.md')), found.join('\n'));
});

test('a file that is not a dated slug, or not a file, is reported', () => {
  for (const name of ['INDEX.md', 'README.md', '2026-10-20-Upper.md', '2026-10-20-two--hyphens.md', '2026-10-20-slug.txt', 'slug.md']) {
    assert.ok(problemsFor({ [name]: good('2026-10-20') }).some((p) => p.includes('file name is not YYYY-MM-DD-slug.md')), name);
  }
  assert.ok(problemsFor({ '2026-10-20-dir.md': null }).some((p) => p.includes('not a file')));
});

test('calendar dates: leap day, month ends and nonsense', () => {
  assert.equal(isCalendarDate('2028-02-29'), true);
  assert.equal(isCalendarDate('2026-02-29'), false);
  assert.equal(isCalendarDate('2026-04-31'), false);
  assert.equal(isCalendarDate('2026-1-01'), false);
});

test('the index lists valid fragments newest first and leaves out invalid ones', () => {
  const dir = folder({
    '2026-10-18-old.md': good('2026-10-18', 'Old'),
    '2026-10-21-b-second.md': good('2026-10-21', 'Same day, b'),
    '2026-10-21-a-first.md': good('2026-10-21', 'Same day, a'),
    '2026-10-19-broken.md': 'no heading\n',
  });
  try {
    const lines = renderIndex(readFragments(dir)).split('\n');
    assert.deepEqual(lines, [
      '2026-10-21  Same day, a  (docs/status/2026-10-21-a-first.md)',
      '2026-10-21  Same day, b  (docs/status/2026-10-21-b-second.md)',
      '2026-10-18  Old  (docs/status/2026-10-18-old.md)',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pnpm status:index prints the index and exits 0; a bad folder exits 1 and prints nothing to stdout', () => {
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes('docs/status/'), ok.stdout);
  const dir = folder({ '2026-10-20-first.md': 'no heading\n' });
  try {
    const bad = spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /2026-10-20-first\.md: line 1 is not a "# Title" heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the index is printed, not committed: nothing but fragments lives in docs/status/', () => {
  const stray = readFragments(FRAGMENT_DIR).filter((f) => !f.slug);
  assert.deepEqual(stray.map((f) => f.file), []);
});

test('STATUS.md and the workflow documents point authors at docs/status/ and the index command', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.scripts['status:index'], 'node scripts/status-index.mjs');
  for (const doc of ['../../docs/STATUS.md', '../../CONTRIBUTING.md', '../../docs/engineering/spec-driven-workflow.md', '../../.agents/skills/telesphoros-implement-slice/SKILL.md']) {
    assert.match(read(doc), /docs\/status\//, `${doc} should point at docs/status/`);
  }
  assert.match(read('../../docs/STATUS.md'), /pnpm status:index/);
  assert.match(read('../pull_request_template.md'), /docs\/status\//);
  assert.doesNotMatch(read('../../docs/STATUS.md'), /Update it in the same pull request as any change it describes/, 'the old instruction would send new entries back to the shared file');
});
