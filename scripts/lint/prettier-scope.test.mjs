// Prettier rewrites the bytes of every file in its scope. A file whose SHA-256 is recorded somewhere in the repository (an evidence
// record, a manifest) must keep its bytes, so it has to be in .prettierignore. This test finds every in-scope file whose current hash
// appears in another tracked file and fails if one is not ignored. It also pins the scope to one glob shared by `format` and
// `format:check`, and refuses stale ignore entries. Run by `pnpm test`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const glob = '{apps,packages}/*/{src,test}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}';
const inScope = (path) => /^(apps|packages)\/[^/]+\/(src|test)\/.+\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path);

/** Ignore entries: one repository-relative path per line; blank lines and comments skipped. */
export function ignoreEntries(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/** In-scope files whose hash is recorded elsewhere but which the ignore list leaves to Prettier. */
export function unprotected(files, hashOf, recorded, ignored) {
  return files.filter((file) => inScope(file) && recorded.has(hashOf(file)) && !ignored.includes(file));
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('format and format:check run Prettier on the same source glob', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts.format, `prettier --write "${glob}"`);
  assert.equal(scripts['format:check'], `prettier --check "${glob}"`);
});

test('every in-scope file whose SHA-256 is recorded in the repository is in .prettierignore', () => {
  const files = git('ls-files').split('\n').filter(inScope);
  const hashOf = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  // Every 64-hex string in any tracked text file. A file cannot hold its own hash, so a match always means another file records it.
  const recorded = new Set(git('grep', '-I', '-o', '-h', '-E', '[0-9a-fA-F]{64}').split('\n').filter(Boolean).map((hash) => hash.toLowerCase()));
  const ignored = ignoreEntries(readFileSync(join(root, '.prettierignore'), 'utf8'));
  assert.ok(files.length > 500, `a floor, so an empty scan cannot pass: ${files.length} in-scope files`);
  assert.deepEqual(unprotected(files, hashOf, recorded, ignored), []);
  // Today two rehearsal sources are pinned; both are ignored, and the record still holds their hashes.
  assert.ok(ignored.every((file) => recorded.has(hashOf(file))), 'an ignored file is no longer pinned; remove it from .prettierignore');
});

test('.prettierignore names only existing in-scope files', () => {
  const ignored = ignoreEntries(readFileSync(join(root, '.prettierignore'), 'utf8'));
  assert.ok(ignored.length > 0);
  for (const file of ignored) {
    assert.ok(inScope(file), `${file} is outside the format scope`);
    assert.ok(existsSync(join(root, file)), `${file} does not exist`);
  }
});

test('a pinned in-scope file left out of the ignore list is reported (control)', () => {
  const hashes = { 'apps/a/src/pinned.ts': 'h1', 'apps/a/src/free.ts': 'h2', 'docs/pinned.md': 'h3' };
  const hashOf = (file) => hashes[file];
  const recorded = new Set(['h1', 'h3']);
  assert.deepEqual(unprotected(Object.keys(hashes), hashOf, recorded, []), ['apps/a/src/pinned.ts']);
  assert.deepEqual(unprotected(Object.keys(hashes), hashOf, recorded, ['apps/a/src/pinned.ts']), []);
});
