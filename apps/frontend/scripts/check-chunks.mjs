// Proves code splitting: every page must be a dynamically imported chunk that the entry bundle
// does NOT statically import and index.html does NOT preload. Run after `vite build`.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const PAGES = ['HomePage', 'UploadReportPage', 'NotFoundPage', 'WorkspacePage'];
const ENTRY_GZIP_BUDGET_KB = 150;

const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const html = readFileSync('dist/index.html', 'utf8');
const entries = Object.values(manifest);
const entry = entries.find((chunk) => chunk.isEntry);
const failures = [];

if (!entry) failures.push('no entry chunk found in the manifest');

for (const page of PAGES) {
  const key = Object.keys(manifest).find((k) => k.endsWith(`pages/${page}.tsx`));
  const chunk = key && manifest[key];
  if (!chunk) {
    failures.push(`${page}: not found in the build manifest`);
    continue;
  }
  if (!chunk.isDynamicEntry) failures.push(`${page}: is not a dynamic entry (statically imported?)`);
  if (entry?.imports?.includes(key)) failures.push(`${page}: statically imported by the entry chunk`);
  if (html.includes(chunk.file)) failures.push(`${page}: preloaded by index.html (${chunk.file})`);
}

// Test-only pages (mounted under `import.meta.env.MODE === 'e2e'`) leave no route path in the production build. check-foundation.mjs refuses their chunk.
const TEST_ONLY_ROUTES = [{ page: 'ResultAcknowledgementsTestPage', path: 'e2e/result-acknowledgements' }];
const builtJs = entries.filter((chunk) => chunk.file.endsWith('.js')).map((chunk) => readFileSync(`dist/${chunk.file}`, 'utf8'));
for (const { page, path } of TEST_ONLY_ROUTES) {
  if (builtJs.some((code) => code.includes(path))) failures.push(`${page}: its route path "${path}" is in the production build`);
}

const dynamicCount = entries.filter((c) => c.isDynamicEntry).length;
if (dynamicCount < PAGES.length) failures.push(`expected >= ${PAGES.length} dynamic chunks, found ${dynamicCount}`);

if (entry) {
  const gzipKb = gzipSync(readFileSync(`dist/${entry.file}`)).length / 1024;
  console.log(`entry chunk: ${entry.file} (${gzipKb.toFixed(1)} kB gzip, budget ${ENTRY_GZIP_BUDGET_KB} kB)`);
  if (gzipKb > ENTRY_GZIP_BUDGET_KB) failures.push(`entry chunk exceeds ${ENTRY_GZIP_BUDGET_KB} kB gzip`);
}
console.log(`dynamic page chunks: ${dynamicCount}`);

if (failures.length) {
  console.error('\nCHUNK CHECK FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('chunk check passed: every page is a separate lazy chunk');
