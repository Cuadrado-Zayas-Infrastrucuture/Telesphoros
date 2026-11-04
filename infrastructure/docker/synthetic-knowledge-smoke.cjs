// Run inside the real image by the existing rehearsal, with no network or secrets (spec 032 S3, 3c-1). It proves the synthetic knowledge of the structured
// assessment is in the image and loads with the application's own loader under the rules the API applies to it. Optional argument: the application root
// (default /app), so the same script can be pointed at a local layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] ?? '/app';
(async () => {
  const { loadKnowledge } = require(path.join(root, 'dist/services/knowledge/knowledge-loader.js'));
  const set = await loadKnowledge({ directory: path.join(root, 'synthetic-knowledge'), mode: 'non-production' });
  assert.deepEqual(set.allGuidelines().map((g) => g.id).sort(), ['drugq-genea', 'drugz-genea', 'drugz-genea-geneb']);
  assert.ok(set.files.length > 0 && set.files.every((file) => file.synthetic), 'every file must say it is synthetic');
  console.log(`synthetic knowledge present and loadable: ${set.files.length} files, set ${set.id.slice(0, 12)}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
