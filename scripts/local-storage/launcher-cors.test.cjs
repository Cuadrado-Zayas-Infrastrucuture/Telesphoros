const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyLauncher } = require('./launcher-cors-fixture.cjs');

for (const kind of ['owned', 'review']) {
  test(kind + ': actual child environment and bucket policy enforce real browser origin boundaries', { timeout: 30000 }, async () => {
    const result = await verifyLauncher(kind);
    assert.equal(result.method, 'GET');
    assert.ok(Object.entries(result).filter(([key]) => !['kind', 'method'].includes(key)).every(([, value]) => value === true));
  });
  test(kind + ': deleting its child CORS setting is detected by the native refusal control', { timeout: 30000 }, async () => {
    await assert.rejects(() => verifyLauncher(kind, 'remove-setting'), error => error.code === 'EXCLUDED_ORIGIN_ADMITTED');
  });
}
test('owned: dropping the setting at the actual worker handoff is detected', { timeout: 30000 }, async () => {
  await assert.rejects(() => verifyLauncher('owned', 'drop-worker-setting'), error => error.code === 'EXCLUDED_ORIGIN_ADMITTED');
});
