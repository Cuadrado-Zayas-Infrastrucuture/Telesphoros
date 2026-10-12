// Local synthetic runtime only. A sealed control copy, directory inode and process start
// identity must agree before any signal or removal. Names/ports alone never prove ownership.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, '.local-storage');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const names = ['postgres', 'moto', 'api', 'idp', 'web'];
function refuse() { throw new Error('Local ownership verification refused; resources retained.'); }
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) refuse();
  return { dev: s.dev, ino: s.ino };
}
function ensureBase() {
  for (const dir of [base, path.join(base, 'runs'), path.join(base, 'control')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    privateDir(dir);
  }
}
function atomic(file, data) {
  const temp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function read(file, limit = 262144) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > limit) refuse();
  return fs.readFileSync(file, 'utf8');
}
function location(id) { if (!uuid.test(id)) refuse(); return path.join(base, 'runs', id); }
function control(id) { location(id); return path.join(base, 'control', id + '.json'); }
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) refuse();
  try {
    const result = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(result);
    return !match || /^[ZX]/.test(match[1]) ? null : match[2];
  } catch (e) { if (e.status === 1) return null; throw e; }
}
function seal(m) {
  ensureBase();
  const content = JSON.stringify(m, null, 2) + '\n';
  // The independently stored control copy is never inferred from names in a supplied manifest.
  atomic(control(m.id), content);
  if (m.phase !== 'removed') atomic(path.join(location(m.id), 'manifest.json'), content);
}
function validate(m) {
  if (m.schema !== 1 || m.synthetic !== true || !uuid.test(m.id) || m.root !== location(m.id) || m.clinicalProcessing !== 'disabled' || m.host !== '127.0.0.1') refuse();
  if (m.database !== 'synthetic_storage_' + m.id.replaceAll('-', '') || m.bucket !== 'synthetic-storage-' + m.id || m.role !== 'storage_app') refuse();
  if (!['preparing', 'ready', 'stopping', 'failed', 'removed'].includes(m.phase)) refuse();
  if (names.some(n => !Number.isInteger(m.ports[n]) || m.ports[n] < 1024 || m.ports[n] > 65535) || new Set(Object.values(m.ports)).size !== 5) refuse();
  if (!Array.isArray(m.processes) || m.processes.length > 5) refuse();
  for (const p of m.processes) {
    if (!names.includes(p.name) || typeof p.identity !== 'string' || !p.identity.includes(path.join(__dirname, 'worker.cjs') + ' ' + m.id + ' ' + p.name)) refuse();
  }
  return m;
}
function load(id) {
  ensureBase();
  const text = read(control(id)); const m = validate(JSON.parse(text));
  if (m.id !== id) refuse();
  if (m.phase === 'removed') { if (fs.existsSync(m.root)) refuse(); return m; }
  const stat = privateDir(m.root);
  if (stat.dev !== m.directory.dev || stat.ino !== m.directory.ino || read(path.join(m.root, 'manifest.json')) !== text) refuse();
  const allowed = new Set(['manifest.json', 'postgres', 'moto', 'tmp', 'stage', 'logs', 'multipart.json', 'sweeps.json', 'clock.json', 'blast-radius.md']);
  if (fs.readdirSync(m.root).some(n => !allowed.has(n))) refuse();
  return m;
}
function live(p) {
  const current = identity(p.pid);
  if (current && current !== p.identity) throw new Error('Local process identity mismatch; resources retained.');
  return !!current;
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', () => reject(new Error('Occupied local port; no service was contacted or stopped.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}
function checkTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name); const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (!s.isDirectory() && !s.isFile())) refuse();
    if (s.isDirectory()) checkTree(file);
  }
}
function remove(m) {
  load(m.id); if (m.processes.some(live)) refuse();
  checkTree(m.root);
  fs.rmSync(m.root, { recursive: true });
  m.phase = 'removed'; m.removedAt = new Date().toISOString(); seal(m);
}
function lock(id) {
  const file = path.join(base, 'control', id + '.lock');
  if (fs.existsSync(file)) {
    const saved = JSON.parse(read(file));
    if (identity(saved.pid)) refuse();
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}
module.exports = { root, base, names, uuid, ensureBase, location, privateDir, atomic, read, identity, seal, load, validate, live, free, checkTree, remove, lock };
