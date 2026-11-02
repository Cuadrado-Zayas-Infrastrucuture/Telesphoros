const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {test} = require('node:test');
const {libraryPaths, rejectNativeAddons} = require('./runtime-rootfs.cjs');
const fixture = ['libdl.so.2', 'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6']
  .map(name => `  ${name} => /lib/x86_64-linux-gnu/${name} (0x00000001)`)
  .concat('  /lib64/ld-linux-x86-64.so.2 (0x00000002)', '  linux-vdso.so.1 (0x00000003)').join('\n');
test('accepts the actual Node shared-library closure including the loader', () => assert.equal(libraryPaths(fixture).length, 7));
test('refuses an unresolved library', () => assert.throws(() => libraryPaths(fixture + '\nlibz.so.1 => not found'), /missing/));
test('refuses an added system-zlib dependency', () => assert.throws(() => libraryPaths(fixture + '\nlibz.so.1 => /lib/libz.so.1 (0x1)'), /dependencies changed/));
test('refuses a missing loader', () => assert.throws(() => libraryPaths(fixture.replace(/.*ld-linux.*\n/, '')), /dependencies changed/));
test('new native addons require review, including nested packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-closure-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'nested'), {recursive: true});
    writeFileSync(join(dir, 'node_modules', 'nested', 'index.js'), 'module.exports = {};');
    assert.doesNotThrow(() => rejectNativeAddons(dir));
    writeFileSync(join(dir, 'node_modules', 'nested', 'addon.node'), 'synthetic');
    assert.throws(() => rejectNativeAddons(dir), /native addon/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('renaming native ELF code cannot bypass dependency review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-elf-'));
  try {
    writeFileSync(join(dir, 'renamed'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert.throws(() => rejectNativeAddons(dir), /native ELF code/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('an external application symlink cannot add undeclared runtime dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-link-'));
  try {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'outside.js'), 'synthetic');
    symlinkSync('../outside.js', join(dir, 'app', 'alias'));
    assert.throws(() => rejectNativeAddons(join(dir, 'app')), /symlink leaves/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a dangling internal deployment-index alias carries no native payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-index-'));
  try {
    symlinkSync('missing-index-entry', join(dir, 'alias'));
    assert.doesNotThrow(() => rejectNativeAddons(dir));
    symlinkSync('../outside-missing', join(dir, 'outside'));
    assert.throws(() => rejectNativeAddons(dir), /symlink leaves/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
