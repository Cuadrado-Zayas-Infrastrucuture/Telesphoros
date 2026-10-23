// The local review demos read the imported reader's development captures. The public repository does not carry them (see
// docs/lab-report-reader.md, "The engine is optional"); say so plainly instead of failing on a missing file.
const { existsSync } = require('node:fs');
const path = require('node:path');

module.exports = function requireReaderFixtures(root = path.resolve(__dirname, '../..')) {
  const missing = ['knowledge/lab-report-reader/v2-handoff/fixtures/captures', 'sidecars/report-reader/reader_cli.py'].filter((p) => !existsSync(path.join(root, p)));
  if (missing.length > 0) {
    console.error(`This demo needs the report-reader development captures, which are not in this checkout (missing: ${missing.join(', ')}).`);
    process.exit(1);
  }
};
