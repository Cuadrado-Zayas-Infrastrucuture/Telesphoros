// Build-only: assemble the declared Node runtime, retaining truthful Debian inventory.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LIBRARIES = new Set(['libdl.so.2', 'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6', 'ld-linux-x86-64.so.2']);
function libraryPaths(output) {
  assert.ok(!output.includes('not found'), 'a Node library is missing');
  const files = output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(?:\S+ => )?(\/\S+)\s+\(/);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(new Set(files.map(file => path.basename(file))), LIBRARIES, 'Node runtime dependencies changed: review the runtime closure');
  return files;
}
function rejectNativeAddons(dir) {
  const root = fs.realpathSync(dir), seen = new Set();
  function visit(file) {
    assert.ok(!file.endsWith('.node'), 'a native addon needs a reviewed runtime dependency closure');
    let real;
    try { real = fs.realpathSync(file); } catch (error) {
      if (error.code !== 'ENOENT' || !fs.lstatSync(file).isSymbolicLink()) throw error;
      // pnpm's deployment index can retain dangling internal aliases after the
      // existing source/test cleanup. They carry no code; outside aliases fail.
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      assert.ok(target === root || target.startsWith(root + path.sep), `dangling runtime symlink leaves the application: ${fs.readlinkSync(file)}`);
      return;
    }
    assert.ok(real === root || real.startsWith(root + path.sep), 'runtime input symlink leaves the deployed application');
    if (seen.has(real)) return;
    seen.add(real);
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(real)) visit(path.join(real, name));
    } else if (stat.isFile()) {
      const fd = fs.openSync(real, 'r'), magic = Buffer.alloc(4);
      try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      assert.ok(!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'native ELF code needs a reviewed runtime dependency closure');
    }
  }
  visit(root);
}
function assemble(dest) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64', 'the hosted image is linux/amd64');
  assert.ok(!fs.existsSync(dest), 'never overwrite an existing root');
  const copy = file => {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    fs.copyFileSync(file, target);
    fs.chmodSync(target, fs.statSync(file).mode & 0o777);
  };
  rejectNativeAddons('/runtime-input');
  const libs = libraryPaths(execFileSync('ldd', ['/usr/local/bin/node'], {encoding: 'utf8'}));
  for (const file of ['/usr/local/bin/node', ...libs, '/etc/os-release', '/etc/debian_version']) copy(file);
  const write = (file, text) => {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    fs.writeFileSync(target, text, {mode: 0o644});
  };
  // These three packages own the copied shared libraries. Do not drop the package
  // database to make scanners blind: libc findings must remain visible.
  const packages = ['libc6', 'libgcc-s1', 'libstdc++6'];
  const status = execFileSync('dpkg-query', ['--status', ...packages], {encoding: 'utf8'});
  assert.equal((status.match(/^Package: /gm) || []).length, packages.length);
  write('/var/lib/dpkg/status', status);
  for (const name of packages) copy(`/usr/share/doc/${name}/copyright`);
  write('/etc/passwd', 'app:x:10001:10001:Application:/app:/nonexistent\n');
  write('/etc/group', 'app:x:10001:\n');
  write('/etc/nsswitch.conf', 'passwd: files\ngroup: files\nhosts: files dns\nnetworks: files\n');
  write('/etc/fstab', '# No user mounts in the application runtime.\n');
  console.log(`runtime root: Node and ${libs.length} reviewed shared libraries; ${packages.length} Debian inventory records`);
}
module.exports = {libraryPaths, rejectNativeAddons};
if (require.main === module) assemble(process.argv[2] || '/runtime-rootfs');
