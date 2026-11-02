// Run inside the real image by the existing rehearsal, with no network or secrets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {lookup} = require('node:dns').promises;
const {gzipSync, gunzipSync} = require('node:zlib');
const path = require('node:path');
async function main() {
  assert.equal(process.getuid(), 10001);
  for (const key of ['LANG', 'LC_ALL', 'LANGUAGE']) assert.equal(process.env[key], 'C');
  for (const file of ['/bin/sh', '/usr/bin/mount', '/usr/bin/nsenter', '/usr/sbin/blkid', '/usr/bin/dpkg', '/usr/bin/apt', '/usr/local/bin/npm']) assert.ok(!fs.existsSync(file), `${file} must be absent`);
  const inventory = fs.readFileSync('/var/lib/dpkg/status', 'utf8');
  assert.deepEqual([...inventory.matchAll(/^Package: (.+)$/gm)].map(match => match[1]).sort(), ['libc6', 'libgcc-s1', 'libstdc++6']);
  assert.match(inventory, /^Source: glibc$/m);
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^ID=debian$/m);
  function inspect(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      assert.ok(!/^(libz\.so|libmount\.so|libblkid\.so)/.test(entry.name), `${file} is an excluded library`);
      assert.equal(fs.lstatSync(file).mode & 0o6000, 0, `${file} has a setuid/setgid bit`);
      if (entry.isDirectory()) inspect(file);
    }
  }
  for (const dir of ['/usr', '/lib', '/lib64', '/app']) inspect(dir);
  assert.ok(!fs.existsSync('/usr/lib/locale'), 'non-C locales require a security review');
  assert.throws(() => fs.writeFileSync('/app/runtime-write-probe', 'synthetic'), error => ['EROFS', 'EACCES'].includes(error.code));
  const bytes = Buffer.from('synthetic runtime compression control');
  assert.deepEqual(gunzipSync(gzipSync(bytes)), bytes);
  assert.ok((await lookup('localhost')).address);
  console.log('PASS minimal runtime: nonroot, read-only, C locale, accurate inventory, no excluded libraries/privileged tools; Node gzip and NSS work');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
