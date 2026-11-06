// Run inside the real image by the existing rehearsal, the way ECS runs the API task: read-only root, user 10001, and a fresh, empty volume mounted at /tmp
// (the task's `scratch` volume). Report intake stages every upload with mkdtemp under os.tmpdir(); on 2026-11-05 that failed with EACCES on staging.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
assert.equal(process.getuid(), 10001);
assert.equal(os.tmpdir(), '/tmp');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telesphoros-intake-'));
const file = path.join(dir, 'probe');
fs.writeFileSync(file, 'synthetic', {mode: 0o600});
assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic');
fs.rmSync(dir, {recursive: true});
console.log('PASS upload staging: user 10001 can create, write, read and remove a temporary folder on a fresh /tmp volume');
