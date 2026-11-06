// Run with: node --test .github/ci/doc-links.test.mjs   (pnpm test:ci-config)
// The pages a newcomer reads first must not send them to a file that is not there (docs/ops/team-access.md is the
// hand-over map). It checks that each relative link's target file exists; it does not check headings inside a page.
// Dated records (docs/status, docs/verification, docs/design, specs, CHANGELOG.md) keep the links of their own date
// and are not read here: some of them point at logs on the machine that produced them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const REPO = new URL('../../', import.meta.url);
const TOP = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'SECURITY.md', 'SUPPORT.md', 'MAINTAINERS.md', 'CODE_OF_CONDUCT.md'];
const FOLDERS = ['docs/', 'docs/ops/', 'docs/engineering/', 'docs/adr/'];
const README_ROOTS = ['apps/', 'packages/', 'infrastructure/', 'sidecars/', 'scripts/'];
const LINK = /\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;

const exists = (path) => existsSync(new URL(path, REPO));

/** The entry pages: the top-level documents, every page directly in the entry folders, and each package's README. */
export function entryDocs() {
  const pages = (folder) =>
    readdirSync(new URL(folder, REPO), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${folder}${e.name}`);
  const readmes = README_ROOTS.flatMap((root) =>
    readdirSync(new URL(root, REPO), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${root}${e.name}/README.md`),
  ).filter(exists);
  return [...TOP.filter(exists), ...FOLDERS.flatMap(pages), ...readmes];
}

/** The relative link targets in the Markdown `text` of the page at `from`, outside code, with whether each file exists. */
export function relativeLinks(from, text, fileExists = (url) => existsSync(url)) {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '``');
  return [...prose.matchAll(LINK)].flatMap((match) => {
    const target = match[1] ?? match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return [];
    const path = target.split(/[#?]/)[0];
    const url = path.startsWith('/') ? new URL(path.slice(1), REPO) : new URL(path, new URL(from, REPO));
    return [{ target, found: fileExists(url) }];
  });
}

test('every relative link in the entry pages names a file that exists', () => {
  const pages = entryDocs();
  let links = 0;
  const broken = pages.flatMap((page) => {
    const found = relativeLinks(page, readFileSync(new URL(page, REPO), 'utf8'));
    links += found.length;
    return found.filter((l) => !l.found).map((l) => `${page} -> ${l.target}`);
  });
  assert.ok(pages.length >= 60 && links >= 500, `expected at least 60 pages and 500 links, read ${pages.length} and ${links}: a scan that finds nothing proves nothing`);
  assert.deepEqual(broken, []);
});

test('the entry pages include the hand-over map and leave the dated records out', () => {
  const pages = entryDocs();
  for (const page of ['README.md', 'CONTRIBUTING.md', 'docs/README.md', 'docs/start-here.md', 'docs/architecture.md', 'docs/ops/team-access.md', 'apps/backend/README.md'])
    assert.ok(pages.includes(page), `${page} is not read`);
  assert.deepEqual(pages.filter((p) => /^(docs\/(status|verification|design)\/|specs\/|CHANGELOG\.md$)/.test(p)), []);
});

test('the link check finds a missing file and passes real ones (controls)', () => {
  const check = (text) => relativeLinks('docs/ops/team-access.md', text).map((l) => [l.target, l.found]);
  assert.deepEqual(check('[gone](no-such-page.md) and [here](ci-cd.md)'), [['no-such-page.md', false], ['ci-cd.md', true]]);
  assert.deepEqual(check('[up](../README.md#documentation-map) [root](/CONTRIBUTING.md) [<angle>](<../start-here.md>)'), [
    ['../README.md#documentation-map', true],
    ['/CONTRIBUTING.md', true],
    ['../start-here.md', true],
  ]);
  assert.deepEqual(check('[web](https://example.com/x.md) [mail](mailto:a@example.com) [here](#before-production)'), []);
  assert.deepEqual(check('```\n[in a block](missing.md)\n```\nand `[inline](missing.md)`'), []);
  assert.deepEqual(check('[spaces](no%20such%20page.md)'), [['no%20such%20page.md', false]]);
});
